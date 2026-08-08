'use strict';

const fs = require('fs').promises;
const path = require('path');

// mock WorkspaceAI so integration tests can exercise the full reminder flow without real OpenAI calls.
jest.mock('../src/workspace-ai');
const MockWorkspaceAI = require('../src/workspace-ai');
const { ConfigureMockWorkspaceAI } = require('./mocks/mock-workspace-ai');

const RemindersModule = require('../src/reminders-module');
const RemindersAIPipeline = require('../src/reminders-ai-pipeline');
const { BuildCompactTextForReminder } = require('../src/reminders-display-utils');
const { MockSlackApp } = require('./mocks/mock-slack-app');

/** Shared workspace info used across all integration tests. */
const TestWorkspaceInfo = {
  WORKSPACE_NAME: 'IntegrationWorkspace',
  ADMIN_EMAIL: 'admin@example.com',
  LIVE_TOKEN: 'xoxb-test',
  LIVE_SIGNING_SECRET: 'secret',
  LIVE_APP_TOKEN: 'xapp-test',
  OPENAI_API_KEY: 'sk-test',
  REMINDER_CHANNEL_NAME: 'test-reminders',
  MAIN_TIMEZONE: 'America/Los_Angeles',
};

/** Minimal stats shape required by RemindersModule.StartAsync. */
const EmptyWorkspaceStats = {
  IncomingMessageCount: 0,
  IncomingMessageLength: 0,
  OutgoingMessageCount: 0,
  OutgoingMessageLength: 0,
  OutgoingGptMessageCount: 0,
  OutgoingGptMessageLength: 0,
  IncomingGptMessageCount: 0,
  IncomingGptMessageLength: 0,
};

/**
 * Create unique workspace info for a test case.
 * @param {string} ArgSuffix Unique suffix for the workspace name.
 * @returns {typeof TestWorkspaceInfo}
 */
function MakeWorkspaceInfo(ArgSuffix) {
  return {
    ...TestWorkspaceInfo,
    WORKSPACE_NAME: `IntegrationWorkspace_${ArgSuffix}`,
  };
}

/**
 * Build reminder runtime file paths for a workspace.
 * @param {string} ArgWorkspaceName Workspace name.
 * @returns {{ remindersFilePath: string, counterFilePath: string, enabledChannelsFilePath: string, completedFilePath: string, eventsFilePath: string }}
 */
function GetReminderRuntimePaths(ArgWorkspaceName) {
  const RemindersDirPath = path.join(__dirname, '..', 'data', 'runtime', 'reminders');
  const EventsDirPath = path.join(__dirname, '..', 'data', 'runtime', 'events');
  return {
    remindersFilePath: path.join(RemindersDirPath, `${ArgWorkspaceName}_reminders.json`),
    counterFilePath: path.join(RemindersDirPath, `${ArgWorkspaceName}_reminder_counter.json`),
    enabledChannelsFilePath: path.join(RemindersDirPath, `${ArgWorkspaceName}_enabled_channels.json`),
    completedFilePath: path.join(RemindersDirPath, `${ArgWorkspaceName}_completed.json`),
    eventsFilePath: path.join(EventsDirPath, `${ArgWorkspaceName}_events.jsonl`),
  };
}

/**
 * Delete reminder runtime files for a workspace.
 * @param {string} ArgWorkspaceName Workspace name.
 * @returns {Promise<void>}
 */
async function CleanupReminderRuntimeFilesAsync(ArgWorkspaceName) {
  const RuntimePaths = GetReminderRuntimePaths(ArgWorkspaceName);
  await fs.mkdir(path.dirname(RuntimePaths.remindersFilePath), { recursive: true });
  await Promise.all(Object.values(RuntimePaths).map(async (ArgPath) => {
    await fs.rm(ArgPath, { force: true });
  }));
}

describe('RemindersModule integration via MockSlackApp', () => {
  test('REMINDERS_READ_SOURCE loads a lossless baseline projection and rolls back to JSON', async () => {
    const WorkspaceInfo = MakeWorkspaceInfo('projection_read_source');
    const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);
    const Reminder = {
      ReminderID: 'projection-reminder-1', CreatedOn: '2026-08-01T12:00:00.000Z',
      ShouldPostOn: '2026-08-02T12:00:00.000Z', TargetChannelID: 'C_REMINDERS',
      OriginalChannelID: 'C_SOURCE', OriginalMessageID: '100.200', OriginalThreadTs: '100.000',
      OriginalSenderID: 'U_SENDER', OriginalChannelName: 'engineering', ReminderMessageText: 'Ship projection read',
      IgnoreSnooze: false, AssigneeID: 'U_OWNER', AssigneeIDs: ['U_OWNER'], GitHubUrls: [],
      clientId: null, projectId: null, State: 'scheduled',
    };
    const BaselineEvent = {
      v: 1, id: 'baseline-projection-reminder-1', ts: Reminder.CreatedOn, workspace: WorkspaceInfo.WORKSPACE_NAME,
      type: 'BaselineReminderImported', reminderId: Reminder.ReminderID,
      payload: {
        text: Reminder.ReminderMessageText, assigneeId: Reminder.AssigneeID, assigneeIds: Reminder.AssigneeIDs,
        sourceChannelId: Reminder.OriginalChannelID, targetChannelId: Reminder.TargetChannelID,
        dueAt: Reminder.ShouldPostOn, state: Reminder.State, githubUrls: Reminder.GitHubUrls,
        createdOn: Reminder.CreatedOn, originalSenderId: Reminder.OriginalSenderID,
        originalMessageId: Reminder.OriginalMessageID, originalThreadTs: Reminder.OriginalThreadTs,
        originalChannelName: Reminder.OriginalChannelName, ignoreSnooze: Reminder.IgnoreSnooze,
        clientId: Reminder.clientId, projectId: Reminder.projectId,
      },
    };
    await fs.mkdir(path.dirname(RuntimePaths.remindersFilePath), { recursive: true });
    await fs.mkdir(path.dirname(RuntimePaths.eventsFilePath), { recursive: true });
    await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify([Reminder]), 'utf8');
    await fs.writeFile(RuntimePaths.eventsFilePath, `${JSON.stringify(BaselineEvent)}\n`, 'utf8');

    process.env.REMINDERS_READ_SOURCE = 'projection';
    const ProjectionModule = new RemindersModule(new MockSlackApp({ WorkspaceInfo }));
    await ProjectionModule.StartAsync(EmptyWorkspaceStats);
    expect(ProjectionModule.GetAllReminders()).toMatchObject([{ ReminderID: Reminder.ReminderID, ReminderMessageText: Reminder.ReminderMessageText, State: 'scheduled' }]);
    await ProjectionModule.StopAsync();

    delete process.env.REMINDERS_READ_SOURCE;
    const RollbackModule = new RemindersModule(new MockSlackApp({ WorkspaceInfo }));
    await RollbackModule.StartAsync(EmptyWorkspaceStats);
    expect(RollbackModule.GetAllReminders()).toMatchObject([{ ReminderID: Reminder.ReminderID, ReminderMessageText: Reminder.ReminderMessageText, State: 'scheduled' }]);
    await RollbackModule.StopAsync();
    await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
  });

  describe('show reminders', () => {
    test('show reminders posts empty-state message when queue is empty', async () => {
      const SlackApp = new MockSlackApp({ WorkspaceInfo: TestWorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);
      await Reminders.StartAsync(EmptyWorkspaceStats);

      const WasHandled = await SlackApp.SimulateAppMentionAsync({
        channel: 'C_REMINDERS',
        user: 'U_REQUESTER',
        text: `${SlackApp.AppMentionString} show reminders`,
      });

      expect(WasHandled).toBe(true);
      expect(SlackApp.SentMessages).toHaveLength(1);
      expect(SlackApp.SentMessages[0].channel).toBe('C_REMINDERS');
      expect(SlackApp.SentMessages[0].threadTs).not.toBeNull();
      expect(SlackApp.SentMessages[0].text).toBe('There are no pending reminders.');
    });

    test('show my reminders posts user empty-state when queue is empty', async () => {
      const SlackApp = new MockSlackApp({ WorkspaceInfo: TestWorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);
      await Reminders.StartAsync(EmptyWorkspaceStats);

      const WasHandled = await SlackApp.SimulateAppMentionAsync({
        channel: 'C_REMINDERS',
        user: 'U_REQUESTER',
        text: `${SlackApp.AppMentionString} show my reminders`,
      });

      expect(WasHandled).toBe(true);
      expect(SlackApp.SentMessages).toHaveLength(1);
      expect(SlackApp.SentMessages[0].text).toBe('You have no pending reminders.');
    });

    test('show reminders github posts empty-state message when queue has no GitHub-linked reminders', async () => {
      const SlackApp = new MockSlackApp({ WorkspaceInfo: TestWorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);
      await Reminders.StartAsync(EmptyWorkspaceStats);

      const WasHandled = await SlackApp.SimulateAppMentionAsync({
        channel: 'C_REMINDERS',
        user: 'U_REQUESTER',
        text: `${SlackApp.AppMentionString} show reminders github`,
      });

      expect(WasHandled).toBe(true);
      expect(SlackApp.SentMessages).toHaveLength(1);
      expect(SlackApp.SentMessages[0].text).toBe('There are no pending reminders with GitHub links.');
    });

    test('show reminders github here lists only GitHub-linked reminders from the current channel', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('show_github_reminders_here');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);
      const ReminderSeed = [
        {
          ReminderID: '33333333-3333-3333-3333-333333333333',
          CreatedOn: '2026-03-19T16:00:00.000Z',
          ShouldPostOn: '2026-03-20T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000003',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Review Sleuth PR 225',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: ['https://github.com/NeochromeTeam/sleuth-app/pull/225'],
          State: 'scheduled',
        },
        {
          ReminderID: '44444444-4444-4444-4444-444444444444',
          CreatedOn: '2026-03-19T17:00:00.000Z',
          ShouldPostOn: '2026-03-21T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000004',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Prepare launch notes',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
        {
          ReminderID: '55555555-5555-5555-5555-555555555555',
          CreatedOn: '2026-03-19T18:00:00.000Z',
          ShouldPostOn: '2026-03-22T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_OTHER',
          OriginalMessageID: '1773990000.000005',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Fix GitHub issue 718',
          IgnoreSnooze: false,
          OriginalChannelName: 'other',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: ['https://github.com/ClientA/universal-child-theme-oct-2024/issues/718'],
          State: 'scheduled',
        },
      ];
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_REQUESTER',
          text: `${SlackApp.AppMentionString} show reminders github here`,
        });

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages).toHaveLength(2);
        expect(SlackApp.SentMessages[0].text).toBe('Pending reminders with GitHub links (1 total):');
        expect(SlackApp.SentMessages[1].text).toContain('Review Sleuth PR 225');
        expect(SlackApp.SentMessages[1].text).not.toContain('Prepare launch notes');
        expect(SlackApp.SentMessages[1].text).not.toContain('Fix GitHub issue 718');
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('show my reminders surfaces reminder whose AssigneeID is null by falling back to OriginalSenderID', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('show_my_reminders_null_assignee_fallback');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);
      const ReminderSeed = [
        {
          ReminderID: 'cccccccc-0000-0000-0000-cccccccccccc',
          CreatedOn: '2026-03-19T16:00:00.000Z',
          ShouldPostOn: '2026-03-20T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000099',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Follow up on deploy checklist',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: null,
          GitHubUrls: null,
          State: 'scheduled',
        },
      ];
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_REQUESTER',
          text: `${SlackApp.AppMentionString} show my reminders`,
        });

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages.length).toBeGreaterThanOrEqual(1);
        expect(SlackApp.SentMessages[0].text).toBe('Pending reminders (1 total):');
        const BodyText = SlackApp.SentMessages.map(ArgMessage => ArgMessage.text).join('\n');
        expect(BodyText).toContain('Follow up on deploy checklist');
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });
  });

  describe('manual force scheduling', () => {
    test('alarm clock reaction infers task title instead of copying the raw question', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('manual_force_task_title');
      const MockProcess = jest.fn().mockImplementation(async (ArgMessageText, _ArgInstructions, ArgSchema) => {
        if(ArgMessageText.includes('BASE DATE:')) {
          return {
            year: 2026,
            month: 5,
            day: 6,
            hour: 8,
            minute: 0,
            second: 0,
            rationale: 'Tomorrow morning in workspace timezone.',
          };
        }

        if(ArgSchema?.name === 'manual_reminder_task_response') {
          return {
            rationale: 'Removed feasibility framing and normalized to an imperative task.',
            reminder_message: 'Change Ground Advantage $5 shipping to $6',
          };
        }

        return {
          recommendation: 'ignore',
          rationale: 'No explicit scheduling trigger in original message.',
          reminders: [],
        };
      });

      MockWorkspaceAI.mockImplementation(() => ({
        ProcessMessageWithJsonResponseAsync: MockProcess,
        ProcessMessageWithTextResponseAsync: jest.fn().mockResolvedValue('mock text response'),
        get ComplexModelName() { return 'gpt-4o'; },
        get DefaultModelName() { return 'gpt-4o-mini'; },
        set DefaultModelName(_) {},
      }));

      const MessageTS = '1773990000.000321';
      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        ThreadMessagesById: {
          [`C_CLIENT:${MessageTS}`]: [{
            user: 'U_CLIENT',
            text: 'How hard is it to make our Ground Advantage $5 shipping to $6',
            ts: MessageTS,
            bot_id: undefined,
            reactions: [],
          }],
        },
      });
      const Reminders = new RemindersModule(SlackApp);

      // this test validates the AI title-synthesis path, which is now opt-in (default OFF), so
      // explicitly enable it here and restore the prior flag afterwards.
      const PriorSynthesisFlag = process.env.REMINDER_TEXT_SYNTHESIS;
      process.env.REMINDER_TEXT_SYNTHESIS = 'on';
      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateReactionAddedAsync({
          user: 'U_OPERATOR',
          reaction: 'alarm_clock',
          item: {
            channel: 'C_CLIENT',
            ts: MessageTS,
          },
        });

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages.length).toBeGreaterThan(0);
        expect(SlackApp.SentMessages[0].text).toContain('Change Ground Advantage $5 shipping to $6');
        expect(SlackApp.SentMessages[0].text).not.toContain(
          '• How hard is it to make our Ground Advantage $5 shipping to $6'
        );
      } finally {
        if(PriorSynthesisFlag === undefined) delete process.env.REMINDER_TEXT_SYNTHESIS;
        else process.env.REMINDER_TEXT_SYNTHESIS = PriorSynthesisFlag;
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('alarm clock reaction preserves the original message verbatim when synthesis is OFF (default)', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('manual_force_raw_default');
      const ExtractCalls = [];
      const MockProcess = jest.fn().mockImplementation(async (ArgMessageText, _ArgInstructions, ArgSchema) => {
        if(ArgMessageText.includes('BASE DATE:')) {
          return { year: 2026, month: 5, day: 6, hour: 8, minute: 0, second: 0, rationale: 'Tomorrow morning.' };
        }

        if(ArgSchema?.name === 'manual_reminder_task_response') {
          // record (and still answer) so we can assert the synthesis LLM call is SKIPPED when OFF.
          ExtractCalls.push(ArgMessageText);
          return { rationale: 'should not be used', reminder_message: 'SYNTHESIZED TITLE' };
        }

        return { recommendation: 'ignore', rationale: 'No explicit scheduling trigger.', reminders: [] };
      });

      MockWorkspaceAI.mockImplementation(() => ({
        ProcessMessageWithJsonResponseAsync: MockProcess,
        ProcessMessageWithTextResponseAsync: jest.fn().mockResolvedValue('mock text response'),
        get ComplexModelName() { return 'gpt-4o'; },
        get DefaultModelName() { return 'gpt-4o-mini'; },
        set DefaultModelName(_) {},
      }));

      const MessageTS = '1773990000.000777';
      const OriginalText = 'How hard is it to make our Ground Advantage $5 shipping to $6';
      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        ThreadMessagesById: {
          [`C_CLIENT:${MessageTS}`]: [{
            user: 'U_CLIENT', text: OriginalText, ts: MessageTS, bot_id: undefined, reactions: [],
          }],
        },
      });
      const Reminders = new RemindersModule(SlackApp);

      const PriorSynthesisFlag = process.env.REMINDER_TEXT_SYNTHESIS;
      delete process.env.REMINDER_TEXT_SYNTHESIS; // default = OFF
      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateReactionAddedAsync({
          user: 'U_OPERATOR',
          reaction: 'alarm_clock',
          item: { channel: 'C_CLIENT', ts: MessageTS },
        });

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages.length).toBeGreaterThan(0);
        // the digest bullet shows the original message verbatim, not the synthesized title...
        expect(SlackApp.SentMessages[0].text).toContain(`• ${OriginalText}`);
        expect(SlackApp.SentMessages[0].text).not.toContain('SYNTHESIZED TITLE');
        // ...and the synthesis LLM call is never made (no wasted work) when synthesis is OFF.
        expect(ExtractCalls).toHaveLength(0);
      } finally {
        if(PriorSynthesisFlag === undefined) delete process.env.REMINDER_TEXT_SYNTHESIS;
        else process.env.REMINDER_TEXT_SYNTHESIS = PriorSynthesisFlag;
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    // GH-337 Phase 2: the force-schedule synthesis gate is now LENGTH-AWARE (per-segment), not the
    // single legacy flag. These two cases lock the new REMINDER_TEXT_SYNTHESIS_LONG behavior on the
    // force-schedule path: a >=4-sentence ("Longer") message synthesizes by DEFAULT, and an explicit
    // _LONG=off suppresses both the synthesis LLM call and the synthesized display text. A helper keeps
    // the two cases byte-identical except for the flag under test.
    const RunForceScheduleLongSegmentCase = async (ArgWorkspaceSlug, ArgMessageTS, ArgSynthesizedTitle) => {
      const WorkspaceInfo = MakeWorkspaceInfo(ArgWorkspaceSlug);
      const ExtractCalls = [];
      const MockProcess = jest.fn().mockImplementation(async (ArgMessageText, _ArgInstructions, ArgSchema) => {
        if(ArgMessageText.includes('BASE DATE:'))
          return { year: 2026, month: 5, day: 6, hour: 8, minute: 0, second: 0, rationale: 'Tomorrow morning.' };
        if(ArgSchema?.name === 'manual_reminder_task_response') {
          ExtractCalls.push(ArgMessageText);
          return { rationale: 'inferred', reminder_message: ArgSynthesizedTitle };
        }
        return { recommendation: 'ignore', rationale: 'No explicit scheduling trigger.', reminders: [] };
      });

      MockWorkspaceAI.mockImplementation(() => ({
        ProcessMessageWithJsonResponseAsync: MockProcess,
        ProcessMessageWithTextResponseAsync: jest.fn().mockResolvedValue('mock text response'),
        get ComplexModelName() { return 'gpt-4o'; },
        get DefaultModelName() { return 'gpt-4o-mini'; },
        set DefaultModelName(_) {},
      }));

      // a >=4-sentence message → routed to the "Longer" synthesis segment. Title is >3 words so the
      // over-compression fallback in #SelectReminderTaskText keeps the synthesized title (doesn't swap
      // in the verbatim actionable span).
      const OriginalText = 'Heads up everyone. Some background context here. A bit more detail follows. Please raise Ground Advantage shipping to six dollars.';
      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        ThreadMessagesById: {
          [`C_CLIENT:${ArgMessageTS}`]: [{
            user: 'U_CLIENT', text: OriginalText, ts: ArgMessageTS, bot_id: undefined, reactions: [],
          }],
        },
      });
      const Reminders = new RemindersModule(SlackApp);

      await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      await Reminders.StartAsync(EmptyWorkspaceStats);
      const WasHandled = await SlackApp.SimulateReactionAddedAsync({
        user: 'U_OPERATOR', reaction: 'alarm_clock', item: { channel: 'C_CLIENT', ts: ArgMessageTS },
      });

      const Result = { WasHandled, ExtractCalls, FirstMessage: SlackApp.SentMessages[0]?.text || '', OriginalText };
      await Reminders.StopAsync();
      await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      return Result;
    };

    test('force-schedule SYNTHESIZES a long (>=4 sentence) message by default (REMINDER_TEXT_SYNTHESIS_LONG defaults ON)', async () => {
      const Prior = ['REMINDER_TEXT_SYNTHESIS', 'REMINDER_TEXT_SYNTHESIS_NORMAL', 'REMINDER_TEXT_SYNTHESIS_LONG']
        .map(Name => [Name, process.env[Name]]);
      Prior.forEach(([Name]) => delete process.env[Name]); // all unset → segment defaults apply (Long ON)
      try {
        const R = await RunForceScheduleLongSegmentCase('force_long_default_on', '1773990000.000910', 'Raise Ground Advantage shipping to six dollars');
        expect(R.WasHandled).toBe(true);
        // the synthesis LLM call IS spent on a long message under the default config...
        expect(R.ExtractCalls).toHaveLength(1);
        // ...and the synthesized title is the displayed task, not the verbatim message.
        expect(R.FirstMessage).toContain('Raise Ground Advantage shipping to six dollars');
        expect(R.FirstMessage).not.toContain(`• ${R.OriginalText}`);
      } finally {
        Prior.forEach(([Name, Val]) => { if(Val === undefined) delete process.env[Name]; else process.env[Name] = Val; });
      }
    });

    test('force-schedule keeps a long message verbatim and skips the synthesis call when REMINDER_TEXT_SYNTHESIS_LONG=off', async () => {
      const Prior = ['REMINDER_TEXT_SYNTHESIS', 'REMINDER_TEXT_SYNTHESIS_NORMAL', 'REMINDER_TEXT_SYNTHESIS_LONG']
        .map(Name => [Name, process.env[Name]]);
      Prior.forEach(([Name]) => delete process.env[Name]);
      process.env.REMINDER_TEXT_SYNTHESIS_LONG = 'off'; // explicitly disable the Long segment
      try {
        const R = await RunForceScheduleLongSegmentCase('force_long_off', '1773990000.000911', 'Raise Ground Advantage shipping to six dollars');
        expect(R.WasHandled).toBe(true);
        // _LONG=off → no wasted synthesis call...
        expect(R.ExtractCalls).toHaveLength(0);
        // ...and the verbatim original is the displayed task, not the (uncomputed) synthesized title.
        expect(R.FirstMessage).toContain(`• ${R.OriginalText}`);
        expect(R.FirstMessage).not.toContain('Raise Ground Advantage shipping to six dollars');
      } finally {
        Prior.forEach(([Name, Val]) => { if(Val === undefined) delete process.env[Name]; else process.env[Name] = Val; });
      }
    });

    // SEAM (end-to-end): a long message goes through the REAL pipeline — analyzer → length-aware
    // synthesis → #ComposeReminderMessageAsync (full original in a `>` blockquote) → append
    // "Key task(s):\n• <synthesized>" → store — and then through the REAL digest line builder
    // (BuildCompactTextForReminder → ExtractCompactSummary), the same one show-reminders uses. This
    // guards the WIRING the unit tests can't: if synthesis stops appending the Key-task bullet, OR the
    // digest stops preferring it over the quoted lead, this fails. (The reported prod bug: the digest
    // showed the raw quoted lead — "com. I'll follow the same method…" — instead of the synthesized task.)
    test('SEAM: a long auto-scheduled message renders its SYNTHESIZED task in the digest line, not the raw quoted lead', async () => {
      const Prior = ['REMINDER_TEXT_SYNTHESIS', 'REMINDER_TEXT_SYNTHESIS_NORMAL', 'REMINDER_TEXT_SYNTHESIS_LONG']
        .map(Name => [Name, process.env[Name]]);
      Prior.forEach(([Name]) => delete process.env[Name]); // segment defaults → Long synthesis ON

      const WorkspaceInfo = MakeWorkspaceInfo('digest_seam_long_synth');
      const MessageTS = '1773990000.000942';
      const SynthTitle = 'Raise Ground Advantage shipping to six dollars';
      // >=4 sentences → routed to the "Longer" synthesis segment. The greeting/context sentences are
      // quote-only fragments that must NOT leak into the digest once the Key task is synthesized.
      const OriginalText = 'Heads up everyone. Some background context here about the shipping tables. '
        + 'A bit more detail follows in the thread. Please raise Ground Advantage shipping to six dollars.';

      const MockProcess = jest.fn().mockImplementation(async (ArgMessageText, _ArgInstructions, ArgSchema) => {
        if(ArgMessageText.includes('BASE DATE:'))
          return { year: 2026, month: 5, day: 6, hour: 8, minute: 0, second: 0, rationale: 'Tomorrow morning.' };
        if(ArgSchema?.name === 'manual_reminder_task_response')
          return { rationale: 'inferred', reminder_message: SynthTitle };
        return { recommendation: 'ignore', rationale: 'No explicit scheduling trigger.', reminders: [] };
      });
      MockWorkspaceAI.mockImplementation(() => ({
        ProcessMessageWithJsonResponseAsync: MockProcess,
        ProcessMessageWithTextResponseAsync: jest.fn().mockResolvedValue('mock text response'),
        get ComplexModelName() { return 'gpt-4o'; },
        get DefaultModelName() { return 'gpt-4o-mini'; },
        set DefaultModelName(_) {},
      }));

      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        ThreadMessagesById: {
          [`C_CLIENT:${MessageTS}`]: [{ user: 'U_CLIENT', text: OriginalText, ts: MessageTS, bot_id: undefined, reactions: [] }],
        },
      });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        // Real pipeline: force-schedule the long message (analyzer + synthesis + compose + store).
        const WasHandled = await SlackApp.SimulateReactionAddedAsync({
          user: 'U_OPERATOR', reaction: 'alarm_clock', item: { channel: 'C_CLIENT', ts: MessageTS },
        });
        expect(WasHandled).toBe(true);

        // The stored reminder genuinely carries BOTH the quoted original AND the synthesized Key-task
        // bullet — the exact shape the digest bug mis-rendered. Assert the precondition (not a hand-built
        // string) so the test proves it's exercising the real quote+bullet case.
        const Scheduled = Reminders.GetAllReminders();
        expect(Scheduled).toHaveLength(1);
        const Stored = Scheduled[0].ReminderMessageText;
        expect(Stored).toContain('Key task(s):');            // synthesis appended the bullet
        expect(Stored).toContain(SynthTitle);                // ...with the synthesized title
        expect(Stored).toContain('background context');      // ...and kept the full quoted original

        // The REAL digest line (same builder show-reminders uses) must surface the synthesized task,
        // never the raw quoted lead.
        const DigestLine = await BuildCompactTextForReminder(SlackApp, Scheduled[0], 'A');
        expect(DigestLine).toContain(SynthTitle);
        expect(DigestLine).not.toContain('background context'); // quoted lead must never win the digest
      } finally {
        Prior.forEach(([Name, Val]) => { if(Val === undefined) delete process.env[Name]; else process.env[Name] = Val; });
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('alarm clock synthetic fallback does not post the past-time warning when no user time was requested', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-05-06T18:56:52.000Z'));

      const WorkspaceInfo = MakeWorkspaceInfo('manual_force_no_false_past_warning');
      const MessageTS = '1773990000.000322';
      const MockProcess = jest.fn().mockImplementation(async (ArgMessageText, _ArgInstructions, ArgSchema) => {
        if(ArgMessageText.includes('BASE DATE:')) {
          return {
            year: 2026,
            month: 5,
            day: 6,
            hour: 11,
            minute: 56,
            second: 0,
            rationale: 'Fallback extraction matched the current wall-clock minute.',
          };
        }

        if(ArgSchema?.name === 'manual_reminder_task_response') {
          return {
            rationale: 'Normalized the task text for manual reminder creation.',
            reminder_message: 'Trace thank you page Upsell code and adjust it to 25%',
          };
        }

        return {
          recommendation: 'ignore',
          rationale: 'No explicit scheduling trigger in original message.',
          reminders: [],
        };
      });

      MockWorkspaceAI.mockImplementation(() => ({
        ProcessMessageWithJsonResponseAsync: MockProcess,
        ProcessMessageWithTextResponseAsync: jest.fn().mockResolvedValue('mock text response'),
        get ComplexModelName() { return 'gpt-4o'; },
        get DefaultModelName() { return 'gpt-4o-mini'; },
        set DefaultModelName(_) {},
      }));

      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        ThreadMessagesById: {
          [`C_CLIENT:${MessageTS}`]: [{
            user: 'U_CLIENT',
            text: 'pls trace thank you page Upsell code when it was changed to 15% and adjust it to 25%',
            ts: MessageTS,
            bot_id: undefined,
            reactions: [],
          }],
        },
      });
      const Reminders = new RemindersModule(SlackApp);

      // exercises the synthesized-title path (opt-in, default OFF); the assertion under test is the
      // absence of the past-time warning, so enable synthesis to keep the title assertion meaningful.
      const PriorSynthesisFlag = process.env.REMINDER_TEXT_SYNTHESIS;
      process.env.REMINDER_TEXT_SYNTHESIS = 'on';
      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateReactionAddedAsync({
          user: 'U_OPERATOR',
          reaction: 'alarm_clock',
          item: {
            channel: 'C_CLIENT',
            ts: MessageTS,
          },
        });

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages.length).toBeGreaterThan(0);
        expect(SlackApp.SentMessages[0].text).toContain('Trace thank you page Upsell code and adjust it to 25%');
        expect(SlackApp.SentMessages[0].text).not.toContain('requested time was in the past');
      } finally {
        if(PriorSynthesisFlag === undefined) delete process.env.REMINDER_TEXT_SYNTHESIS;
        else process.env.REMINDER_TEXT_SYNTHESIS = PriorSynthesisFlag;
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        jest.useRealTimers();
      }
    });
  });

  describe('thread reminder command', () => {
    test('creates a reminder from the task above and defaults to tomorrow at 8 AM when no time is present', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('thread_command_default_8am');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);
      const ParentTS = '1773990000.000401';
      const CommandTS = '1773990000.000402';
      const MockProcess = jest.fn().mockImplementation(async (ArgMessageText, _ArgInstructions, ArgSchema) => {
        if(ArgMessageText.includes('BASE DATE:')) {
          return {
            year: 2026,
            month: 5,
            day: 6,
            hour: 8,
            minute: 0,
            second: 0,
            rationale: 'Tomorrow at 8 AM in workspace timezone.',
          };
        }

        if(ArgSchema?.name === 'manual_reminder_task_response') {
          return {
            rationale: 'not used in this flow',
            reminder_message: 'Review WP DB Toolkit feature',
          };
        }

        return {
          recommendation: 'schedule',
          rationale: 'mock analysis',
          reminders: [{
            actionable_language: 'Review WP DB Toolkit feature',
            scheduling_trigger: 'tomorrow at 8:00 AM',
            reminder_message: 'Review WP DB Toolkit feature',
          }],
        };
      });

      MockWorkspaceAI.mockImplementation(() => ({
        ProcessMessageWithJsonResponseAsync: MockProcess,
        ProcessMessageWithTextResponseAsync: jest.fn().mockResolvedValue('mock text response'),
        get ComplexModelName() { return 'gpt-4o'; },
        get DefaultModelName() { return 'gpt-4o-mini'; },
        set DefaultModelName(_) {},
      }));

      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        ThreadMessagesById: {
          [`C_CLIENT:${ParentTS}`]: [
            {
              user: 'U_REQUESTER',
              text: '<@U_TARGET> please review this feature of WP DB Toolkit issue 76 for the BigQuery sync plan.',
              ts: ParentTS,
              bot_id: undefined,
              reactions: [],
            },
            {
              user: 'U_REQUESTER',
              text: '<@UBOT123> make a Sleuth reminder for <@U_TARGET> based on task above',
              ts: CommandTS,
              bot_id: undefined,
              reactions: [],
            },
          ],
        },
      });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_CLIENT',
          user: 'U_REQUESTER',
          ts: CommandTS,
          thread_ts: ParentTS,
          text: `${SlackApp.AppMentionString} make a Sleuth reminder for <@U_TARGET> based on task above`,
        });

        expect(WasHandled).toBe(true);
        expect(MockProcess).toHaveBeenCalled();
        expect(MockProcess.mock.calls[0][0]).toMatch(/tomorrow at \d{1,2}:\d{2} AM/);
        expect(SlackApp.SentMessages[0].text).toContain('1 Slack reminder has been scheduled for <@U_TARGET>.');

        const PersistedReminders = JSON.parse(await fs.readFile(RuntimePaths.remindersFilePath, 'utf8'));
        expect(PersistedReminders).toHaveLength(1);
        expect(PersistedReminders[0].OriginalMessageID).toBe(ParentTS);
        expect(PersistedReminders[0].AssigneeID).toBe('U_TARGET');
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });
  });

  describe('duplicate bullet regression (multiple candidates, one trigger)', () => {
    test('collapses identical candidate bullets to one when text synthesis is OFF', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('dup_bullet_single_trigger');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);

      // the GPT analyzer returns THREE reminder candidates that all share the SAME scheduling trigger —
      // exactly the shape produced by one multi-item message ("1.) ... 2.) ... all due Friday at 3 PM").
      // with text synthesis OFF, every candidate's displayed text is rewritten to the identical original
      // message, so without deduping they render as three byte-identical bullets even though only ONE
      // reminder is queued for the trigger group.
      const MockProcess = jest.fn().mockImplementation(async (ArgMessageText) => {
        if(ArgMessageText.includes('BASE DATE:')) {
          return { year: 2030, month: 5, day: 7, hour: 15, minute: 0, second: 0, rationale: 'Friday 3 PM.' };
        }
        return {
          recommendation: 'schedule',
          rationale: 'mock analysis with multiple candidates for one trigger',
          reminders: [
            { actionable_language: 'Client C HPOS', scheduling_trigger: 'Friday at 3 PM', reminder_message: 'Client C HPOS - Matt & Mike' },
            { actionable_language: 'QueryGuard logs', scheduling_trigger: 'Friday at 3 PM', reminder_message: 'QueryGuard - look at logs' },
            { actionable_language: 'KISS woo plugin', scheduling_trigger: 'Friday at 3 PM', reminder_message: 'KISS woo fast plugin intercept' },
          ],
        };
      });

      MockWorkspaceAI.mockImplementation(() => ({
        ProcessMessageWithJsonResponseAsync: MockProcess,
        ProcessMessageWithTextResponseAsync: jest.fn().mockResolvedValue('mock text response'),
        get ComplexModelName() { return 'gpt-4o'; },
        get DefaultModelName() { return 'gpt-4o-mini'; },
        set DefaultModelName(_) {},
      }));

      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
      });
      const Reminders = new RemindersModule(SlackApp);

      const PriorSynthesisFlag = process.env.REMINDER_TEXT_SYNTHESIS;
      delete process.env.REMINDER_TEXT_SYNTHESIS; // default = OFF (verbatim message becomes every bullet)
      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.enabledChannelsFilePath, JSON.stringify(['C_ENABLED']), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        await SlackApp.SimulateMessageAsync({
          channel: 'C_ENABLED',
          user: 'U_SENDER',
          text: 'WEEK & PROJECT items: 1.) Client C HPOS 2.) QueryGuard logs 4.) KISS woo plugin — all due for Friday at 3 PM PT',
        });

        const FeedbackMessage = SlackApp.SentMessages.find(ArgMessage => /Slack reminder.*been scheduled/.test(ArgMessage.text));
        expect(FeedbackMessage).toBeDefined();
        // only ONE reminder is queued for the single trigger group ...
        expect(FeedbackMessage.text).toContain('1 Slack reminder has been scheduled');
        // ... and the "Tasks for ..." bullet list shows that task exactly once, not once per candidate.
        const BulletCount = (FeedbackMessage.text.match(/\n• /g) || []).length;
        expect(BulletCount).toBe(1);

        const PersistedReminders = JSON.parse(await fs.readFile(RuntimePaths.remindersFilePath, 'utf8'));
        expect(PersistedReminders).toHaveLength(1);
      } finally {
        if(PriorSynthesisFlag === undefined) delete process.env.REMINDER_TEXT_SYNTHESIS;
        else process.env.REMINDER_TEXT_SYNTHESIS = PriorSynthesisFlag;
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });
  });

  describe('search reminders', () => {
    test('search reminders prompts for keywords when query text is missing', async () => {
      const SlackApp = new MockSlackApp({ WorkspaceInfo: TestWorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);
      await Reminders.StartAsync(EmptyWorkspaceStats);

      const WasHandled = await SlackApp.SimulateAppMentionAsync({
        channel: 'C_REMINDERS',
        user: 'U_REQUESTER',
        text: `${SlackApp.AppMentionString} search reminders`,
      });

      expect(WasHandled).toBe(true);
      expect(SlackApp.SentMessages).toHaveLength(1);
      expect(SlackApp.SentMessages[0].text).toBe('Please provide keywords after `@Sleuth AI search reminders`.');
    });

    test('search reminders posts search-specific empty-state message when queue is empty', async () => {
      const SlackApp = new MockSlackApp({ WorkspaceInfo: TestWorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);
      await Reminders.StartAsync(EmptyWorkspaceStats);

      const WasHandled = await SlackApp.SimulateAppMentionAsync({
        channel: 'C_REMINDERS',
        user: 'U_REQUESTER',
        text: `${SlackApp.AppMentionString} search reminders invoice`,
      });

      expect(WasHandled).toBe(true);
      expect(SlackApp.SentMessages).toHaveLength(1);
      expect(SlackApp.SentMessages[0].text).toBe('No pending reminders found matching "invoice".');
    });

    test('search reminders matches case-insensitively and excludes non-matching reminders', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('search_reminders_case_insensitive');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);
      const ReminderSeed = [
        {
          ReminderID: '66666666-6666-6666-6666-666666666666',
          CreatedOn: '2026-03-19T16:00:00.000Z',
          ShouldPostOn: '2026-03-20T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000006',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Send Invoice to client',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
        {
          ReminderID: '77777777-7777-7777-7777-777777777777',
          CreatedOn: '2026-03-19T17:00:00.000Z',
          ShouldPostOn: '2026-03-21T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000007',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Prepare launch notes',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
      ];
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_REQUESTER',
          text: `${SlackApp.AppMentionString} search reminders   invoice   `,
        });

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages).toHaveLength(2);
        expect(SlackApp.SentMessages[0].text).toBe('Pending reminders matching "invoice" (1 total):');
        expect(SlackApp.SentMessages[1].text).toContain('Send Invoice to client');
        expect(SlackApp.SentMessages[1].text).not.toContain('Prepare launch notes');
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('search reminders returns only matching reminders and preserves reminder ordering', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('search_reminders_multiple_results');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);
      const ReminderSeed = [
        {
          ReminderID: '88888888-8888-8888-8888-888888888888',
          CreatedOn: '2026-03-19T16:00:00.000Z',
          ShouldPostOn: '2026-03-22T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000008',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Review invoice draft',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
        {
          ReminderID: '99999999-9999-9999-9999-999999999999',
          CreatedOn: '2026-03-19T17:00:00.000Z',
          ShouldPostOn: '2026-03-20T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000009',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Send invoice to vendor',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
        {
          ReminderID: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
          CreatedOn: '2026-03-19T18:00:00.000Z',
          ShouldPostOn: '2026-03-21T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000010',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Book travel',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
      ];
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_REQUESTER',
          text: `${SlackApp.AppMentionString} search reminders invoice`,
        });

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages).toHaveLength(3);
        expect(SlackApp.SentMessages[0].text).toBe('Pending reminders matching "invoice" (2 total):');
        expect(SlackApp.SentMessages[1].text).toContain('Send invoice to vendor');
        expect(SlackApp.SentMessages[2].text).toContain('Review invoice draft');
        expect(SlackApp.SentMessages[1].text).not.toContain('Book travel');
        expect(SlackApp.SentMessages[2].text).not.toContain('Book travel');
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('search reminders shows close matches when exact results are unavailable', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('search_reminders_fuzzy_only');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);
      const ReminderSeed = [
        {
          ReminderID: 'bbbbbbbb-1111-2222-3333-cccccccccccc',
          CreatedOn: '2026-03-19T16:00:00.000Z',
          ShouldPostOn: '2026-03-20T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000011',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Send invoice to client',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
        {
          ReminderID: 'cccccccc-1111-2222-3333-dddddddddddd',
          CreatedOn: '2026-03-19T17:00:00.000Z',
          ShouldPostOn: '2026-03-21T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000012',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Prepare launch notes',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
      ];
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_REQUESTER',
          text: `${SlackApp.AppMentionString} search reminders invoce`,
        });

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages).toHaveLength(3);
        expect(SlackApp.SentMessages[0].text).toBe('No exact matches found for "invoce". Showing close matches for longer keywords.');
        expect(SlackApp.SentMessages[1].text).toBe('Close matches for "invoce" (1 total):');
        expect(SlackApp.SentMessages[2].text).toContain('Send invoice to client');
        expect(SlackApp.SentMessages[2].text).not.toContain('Prepare launch notes');
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('search reminders posts exact results before labeled close matches', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('search_reminders_exact_then_fuzzy');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);
      const ReminderSeed = [
        {
          ReminderID: 'dddddddd-1111-2222-3333-eeeeeeeeeeee',
          CreatedOn: '2026-03-19T16:00:00.000Z',
          ShouldPostOn: '2026-03-20T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000013',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Send invoice to vendor',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
        {
          ReminderID: 'eeeeeeee-1111-2222-3333-ffffffffffff',
          CreatedOn: '2026-03-19T17:00:00.000Z',
          ShouldPostOn: '2026-03-21T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000014',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Review invoce draft',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
        {
          ReminderID: 'ffffffff-1111-2222-3333-000000000000',
          CreatedOn: '2026-03-19T18:00:00.000Z',
          ShouldPostOn: '2026-03-22T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000015',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Book travel',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
      ];
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_REQUESTER',
          text: `${SlackApp.AppMentionString} search reminders invoice`,
        });

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages).toHaveLength(4);
        expect(SlackApp.SentMessages[0].text).toBe('Pending reminders matching "invoice" (1 total):');
        expect(SlackApp.SentMessages[1].text).toContain('Send invoice to vendor');
        expect(SlackApp.SentMessages[2].text).toBe('Close matches for "invoice" (1 total):');
        expect(SlackApp.SentMessages[3].text).toContain('Review invoce draft');
        expect(SlackApp.SentMessages[3].text).not.toContain('Book travel');
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('search reminders does not use fuzzy matching for short tokens', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('search_reminders_short_token_no_fuzzy');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);
      const ReminderSeed = [
        {
          ReminderID: '11111111-aaaa-bbbb-cccc-222222222222',
          CreatedOn: '2026-03-19T16:00:00.000Z',
          ShouldPostOn: '2026-03-20T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000016',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Do backlog cleanup',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
      ];
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_REQUESTER',
          text: `${SlackApp.AppMentionString} search reminders db`,
        });

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages).toHaveLength(1);
        expect(SlackApp.SentMessages[0].text).toBe('No pending reminders found matching "db".');
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('search my reminders only returns the requester scoped matches', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('search_my_reminders_scoped');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);
      const ReminderSeed = [
        {
          ReminderID: '12121212-aaaa-bbbb-cccc-343434343434',
          CreatedOn: '2026-03-19T16:00:00.000Z',
          ShouldPostOn: '2026-03-20T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000017',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Send invoice to client',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
        {
          ReminderID: '56565656-aaaa-bbbb-cccc-787878787878',
          CreatedOn: '2026-03-19T17:00:00.000Z',
          ShouldPostOn: '2026-03-21T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000018',
          OriginalSenderID: 'U_OTHER',
          ReminderMessageText: 'Invoice the vendor',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_OTHER',
          GitHubUrls: null,
          State: 'scheduled',
        },
      ];
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_REQUESTER',
          text: `${SlackApp.AppMentionString} search my reminders invoice`,
        });

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages).toHaveLength(2);
        expect(SlackApp.SentMessages[0].text).toBe('Your pending reminders matching "invoice" (1 total):');
        expect(SlackApp.SentMessages[1].text).toContain('Send invoice to client');
        expect(SlackApp.SentMessages[1].text).not.toContain('Invoice the vendor');
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('search reminders for @user only returns that user scoped matches', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('search_reminders_for_user_scoped');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);
      const ReminderSeed = [
        {
          ReminderID: '90909090-aaaa-bbbb-cccc-121212121212',
          CreatedOn: '2026-03-19T16:00:00.000Z',
          ShouldPostOn: '2026-03-20T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000019',
          OriginalSenderID: 'U_MANAGER',
          ReminderMessageText: 'Review invoice with finance',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_TARGET',
          GitHubUrls: null,
          State: 'scheduled',
        },
        {
          ReminderID: '34343434-aaaa-bbbb-cccc-565656565656',
          CreatedOn: '2026-03-19T17:00:00.000Z',
          ShouldPostOn: '2026-03-21T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000020',
          OriginalSenderID: 'U_MANAGER',
          ReminderMessageText: 'Review invoice with legal',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_OTHER',
          GitHubUrls: null,
          State: 'scheduled',
        },
      ];
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_REQUESTER',
          text: `${SlackApp.AppMentionString} search reminders for <@U_TARGET> invoice`,
        });

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages).toHaveLength(2);
        expect(SlackApp.SentMessages[0].text).toBe('Pending reminders for <@U_TARGET> matching "invoice" (1 total):');
        expect(SlackApp.SentMessages[1].text).toContain('Review invoice with finance');
        expect(SlackApp.SentMessages[1].text).not.toContain('Review invoice with legal');
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('search reminders here only returns matches from the current channel', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('search_reminders_here_scoped');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);
      const ReminderSeed = [
        {
          ReminderID: '78787878-aaaa-bbbb-cccc-909090909090',
          CreatedOn: '2026-03-19T16:00:00.000Z',
          ShouldPostOn: '2026-03-20T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.000021',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Ship invoice follow-up',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
        {
          ReminderID: 'abababab-aaaa-bbbb-cccc-cdcdcdcdcdcd',
          CreatedOn: '2026-03-19T17:00:00.000Z',
          ShouldPostOn: '2026-03-21T16:00:00.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_OTHER',
          OriginalMessageID: '1773990000.000022',
          OriginalSenderID: 'U_REQUESTER',
          ReminderMessageText: 'Invoice ops for March',
          IgnoreSnooze: false,
          OriginalChannelName: 'other',
          AssigneeID: 'U_REQUESTER',
          GitHubUrls: null,
          State: 'scheduled',
        },
      ];
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_REQUESTER',
          text: `${SlackApp.AppMentionString} search reminders here invoice`,
        });

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages).toHaveLength(2);
        expect(SlackApp.SentMessages[0].text).toBe('Pending reminders in this channel matching "invoice" (1 total):');
        expect(SlackApp.SentMessages[1].text).toContain('Ship invoice follow-up');
        expect(SlackApp.SentMessages[1].text).not.toContain('Invoice ops for March');
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });
  });

  describe('enable / disable reminders permission guard', () => {
    test('non-creator enable reminders is rejected with the channel-creator message', async () => {
      // ChannelCreatorsById is empty → IsChannelCreatorAsync returns false for everyone.
      const SlackApp = new MockSlackApp({ WorkspaceInfo: TestWorkspaceInfo });
      new RemindersModule(SlackApp);

      const WasHandled = await SlackApp.SimulateAppMentionAsync({
        channel: 'C_GENERAL',
        user: 'U_NON_CREATOR',
        text: `${SlackApp.AppMentionString} enable reminders`,
      });

      expect(WasHandled).toBe(true);
      expect(SlackApp.SentMessages).toHaveLength(1);
      expect(SlackApp.SentMessages[0].text).toBe('Only the channel creator or a workspace admin/owner can enable or disable reminders.');
    });

    test('non-creator disable reminders is rejected with the channel-creator message', async () => {
      const SlackApp = new MockSlackApp({ WorkspaceInfo: TestWorkspaceInfo });
      new RemindersModule(SlackApp);

      const WasHandled = await SlackApp.SimulateAppMentionAsync({
        channel: 'C_GENERAL',
        user: 'U_NON_CREATOR',
        text: `${SlackApp.AppMentionString} disable reminders`,
      });

      expect(WasHandled).toBe(true);
      expect(SlackApp.SentMessages).toHaveLength(1);
      expect(SlackApp.SentMessages[0].text).toBe('Only the channel creator or a workspace admin/owner can enable or disable reminders.');
    });

    test('workspace admin/owner who is not the channel creator can enable reminders', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('enable_admin_escape');
      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        AdminUsers: ['U_WORKSPACE_ADMIN'],
      });
      const Reminders = new RemindersModule(SlackApp);
      try {
        await Reminders.StartAsync();

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_WORKSPACE_ADMIN',
          text: `${SlackApp.AppMentionString} enable reminders`,
        });

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages).toHaveLength(1);
        expect(SlackApp.SentMessages[0].text).toContain('Automatic reminders have been enabled');
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });
  });

  describe('enable / disable reminders happy path', () => {
    test('channel creator can enable reminders and persist the channel ID', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('enable_happy_path');
      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        ChannelCreatorsById: { C_GENERAL: 'U_CREATOR' },
      });
      const Reminders = new RemindersModule(SlackApp);
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_CREATOR',
          text: `${SlackApp.AppMentionString} enable reminders`,
        });

        const EnabledChannels = JSON.parse(await fs.readFile(RuntimePaths.enabledChannelsFilePath, 'utf8'));

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages).toHaveLength(1);
        expect(SlackApp.SentMessages[0].text).toContain('Automatic reminders have been enabled for this channel.');
        expect(EnabledChannels).toEqual(['C_GENERAL']);
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('channel creator can disable reminders and persist the empty enabled-channels list', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('disable_happy_path');
      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        ChannelCreatorsById: { C_GENERAL: 'U_CREATOR' },
      });
      const Reminders = new RemindersModule(SlackApp);
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.enabledChannelsFilePath, JSON.stringify(['C_GENERAL']), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_CREATOR',
          text: `${SlackApp.AppMentionString} disable reminders`,
        });

        const EnabledChannels = JSON.parse(await fs.readFile(RuntimePaths.enabledChannelsFilePath, 'utf8'));

        expect(WasHandled).toBe(true);
        expect(SlackApp.SentMessages).toHaveLength(1);
        expect(SlackApp.SentMessages[0].text).toContain('Automatic reminders have been disabled for this channel.');
        expect(EnabledChannels).toEqual([]);
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });
  });

  describe('disabled-channel :mag: discovery hint', () => {
    test('adds :mag: reaction when message in disabled channel matches the heuristic', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('discovery_hint_match');
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        await SlackApp.SimulateMessageAsync({
          channel: 'C_DISABLED',
          user: 'U_SENDER',
          text: 'please merge PR 766 tonight',
        });

        expect(SlackApp.AddedReactions).toHaveLength(1);
        expect(SlackApp.AddedReactions[0]).toMatchObject({ channel: 'C_DISABLED', reaction: 'mag' });
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('does not add :mag: when message has a negation phrase', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('discovery_hint_negation');
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        await SlackApp.SimulateMessageAsync({
          channel: 'C_DISABLED',
          user: 'U_SENDER',
          text: "please don't deploy today",
        });

        expect(SlackApp.AddedReactions).toHaveLength(0);
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('does not add :mag: when channel has reminders enabled', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('discovery_hint_enabled_channel');
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.enabledChannelsFilePath, JSON.stringify(['C_ENABLED']), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        await SlackApp.SimulateMessageAsync({
          channel: 'C_ENABLED',
          user: 'U_SENDER',
          text: 'please merge PR 766 tonight',
        });

        // reaction list may contain scheduling-path reactions (e.g. gemini) but should not contain :mag:.
        const MagReactions = SlackApp.AddedReactions.filter(r => r.reaction === 'mag');
        expect(MagReactions).toHaveLength(0);
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('does not add :mag: to thread replies', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('discovery_hint_thread_reply');
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        await SlackApp.SimulateMessageAsync({
          channel: 'C_DISABLED',
          user: 'U_SENDER',
          text: 'please merge PR 766 tonight',
          ts: '1234567890.000001',
          thread_ts: '1234567890.000000',
        });

        expect(SlackApp.AddedReactions).toHaveLength(0);
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });
  });

  describe('GH-412: DM channel_type bypasses the enabled-channels gate', () => {
    test('scheduling-trigger message in a 1:1 DM (channel_type=im) schedules despite the channel never being enabled', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('gh412_dm_schedules');
      ConfigureMockWorkspaceAI(MockWorkspaceAI);
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        await SlackApp.SimulateMessageAsync({
          channel: 'D_DM_TEST',
          user: 'U_SENDER',
          text: 'please merge PR 766 tonight',
          channel_type: 'im',
        });

        expect(
          SlackApp.SentMessages.some((ArgMessage) => /Slack reminder.*been scheduled/.test(ArgMessage.text))
        ).toBe(true);
        // no discovery-hint reaction — this went through the real scheduling path, not the disabled-channel heuristic.
        expect(SlackApp.AddedReactions.some((r) => r.reaction === 'mag')).toBe(false);

        const PersistedReminders = JSON.parse(
          await fs.readFile(GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME).remindersFilePath, 'utf8')
        );
        expect(PersistedReminders).toHaveLength(1);
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('a group DM (channel_type=mpim) is NOT bypassed — still gated like a regular disabled channel', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('gh412_mpim_not_bypassed');
      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        await SlackApp.SimulateMessageAsync({
          channel: 'G_GROUP_DM_TEST',
          user: 'U_SENDER',
          text: 'please merge PR 766 tonight',
          channel_type: 'mpim',
        });

        expect(
          SlackApp.SentMessages.some((ArgMessage) => /Slack reminder.*been scheduled/.test(ArgMessage.text))
        ).toBe(false);
        expect(SlackApp.AddedReactions).toHaveLength(1);
        expect(SlackApp.AddedReactions[0]).toMatchObject({ channel: 'G_GROUP_DM_TEST', reaction: 'mag' });
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });
  });

  describe('test random reminder debug command', () => {
    test('test random reminder with empty queue posts no-reminders message', async () => {
      const SlackApp = new MockSlackApp({ WorkspaceInfo: TestWorkspaceInfo });
      new RemindersModule(SlackApp);

      const WasHandled = await SlackApp.SimulateAppMentionAsync({
        channel: 'C_REMINDERS',
        user: 'U_REQUESTER',
        text: `${SlackApp.AppMentionString} test random reminder`,
      });

      expect(WasHandled).toBe(true);
      expect(SlackApp.SentMessages).toHaveLength(1);
      expect(SlackApp.SentMessages[0].text).toBe('No pending reminders available to test.');
    });
  });

  describe('github sync now admin guard', () => {
    test('non-admin github sync now is rejected with the admin-only message', async () => {
      // AdminUsers is empty → IsAdminOrOwnerAsync returns false.
      const SlackApp = new MockSlackApp({ WorkspaceInfo: TestWorkspaceInfo });
      new RemindersModule(SlackApp);

      const WasHandled = await SlackApp.SimulateAppMentionAsync({
        channel: 'C_GENERAL',
        user: 'U_NON_ADMIN',
        text: `${SlackApp.AppMentionString} github sync now`,
      });

      expect(WasHandled).toBe(true);
      expect(SlackApp.SentMessages).toHaveLength(1);
      expect(SlackApp.SentMessages[0].text).toBe(
        'Only workspace admins or owners can trigger a manual GitHub sync.'
      );
    });

    test('admin github sync now with no GitHubSyncModule attached posts unavailable message', async () => {
      const SlackApp = new MockSlackApp({
        WorkspaceInfo: TestWorkspaceInfo,
        AdminUsers: ['U_ADMIN'],
      });
      // GitHubSyncModule is null by default — no module attached.
      new RemindersModule(SlackApp);

      const WasHandled = await SlackApp.SimulateAppMentionAsync({
        channel: 'C_GENERAL',
        user: 'U_ADMIN',
        text: `${SlackApp.AppMentionString} github sync now`,
      });

      expect(WasHandled).toBe(true);
      expect(SlackApp.SentMessages).toHaveLength(1);
      expect(SlackApp.SentMessages[0].text).toBe('GitHub sync module is not available.');
    });

    test('admin github sync now with attached module posts running and success messages', async () => {
      const SlackApp = new MockSlackApp({
        WorkspaceInfo: TestWorkspaceInfo,
        AdminUsers: ['U_ADMIN'],
      });
      const Reminders = new RemindersModule(SlackApp);
      const GitHubSyncModuleMock = {
        RunNowAsync: jest.fn(async () => ({
          ok: true,
          message: 'GitHub sync completed. Check logs for details on any reminders auto-completed.'
        }))
      };
      Reminders.SetGitHubSyncModule(GitHubSyncModuleMock);

      const WasHandled = await SlackApp.SimulateAppMentionAsync({
        channel: 'C_GENERAL',
        user: 'U_ADMIN',
        text: `${SlackApp.AppMentionString} github sync now`,
      });

      expect(WasHandled).toBe(true);
      expect(GitHubSyncModuleMock.RunNowAsync).toHaveBeenCalledTimes(1);
      expect(SlackApp.SentMessages).toHaveLength(2);
      expect(SlackApp.SentMessages[0].text).toBe('Running GitHub sync now…');
      expect(SlackApp.SentMessages[1].text).toBe(
        'SUCCESS: GitHub sync completed. Check logs for details on any reminders auto-completed.'
      );
    });
  });

  describe('reaction flows with reminder metadata', () => {
    test('white check mark reaction completes the reminder and persists an empty queue', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('white_check_mark');
      const ReminderID = '11111111-1111-1111-1111-111111111111';
      const MessageTS = '1774000000.000001';
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);
      const ReminderSeed = [{
        ReminderID,
        CreatedOn: '2026-03-19T16:00:00.000Z',
        ShouldPostOn: '2026-03-20T16:00:00.000Z',
        TargetChannelID: 'C_REMINDERS',
        OriginalChannelID: 'C_GENERAL',
        OriginalMessageID: '1773990000.000001',
        OriginalSenderID: 'U_REQUESTER',
        ReminderMessageText: 'Reminder text',
        IgnoreSnooze: false,
        OriginalChannelName: 'general',
        AssigneeID: 'U_REQUESTER',
        GitHubUrls: null,
        State: 'scheduled',
      }];
      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        MessageMetadataById: {
          [`C_REMINDERS:${MessageTS}`]: {
            event_type: 'sleuth-ai-reminder-ids',
            event_payload: { ReminderIDs: JSON.stringify([ReminderID]) },
          },
        },
      });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateReactionAddedAsync({
          user: 'U_REQUESTER',
          reaction: 'white_check_mark',
          item: { channel: 'C_REMINDERS', ts: MessageTS },
        });

        const PersistedReminders = JSON.parse(await fs.readFile(RuntimePaths.remindersFilePath, 'utf8'));

        expect(WasHandled).toBe(true);
        expect(PersistedReminders).toEqual([]);
        expect(SlackApp.DeletedMessages).toHaveLength(0);
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('wastebasket reaction cancels the reminder and deletes the feedback message', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('wastebasket');
      const ReminderID = '22222222-2222-2222-2222-222222222222';
      const MessageTS = '1774000000.000002';
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);
      const ReminderSeed = [{
        ReminderID,
        CreatedOn: '2026-03-19T16:00:00.000Z',
        ShouldPostOn: '2026-03-20T16:00:00.000Z',
        TargetChannelID: 'C_REMINDERS',
        OriginalChannelID: 'C_GENERAL',
        OriginalMessageID: '1773990000.000002',
        OriginalSenderID: 'U_REQUESTER',
        ReminderMessageText: 'Reminder text',
        IgnoreSnooze: false,
        OriginalChannelName: 'general',
        AssigneeID: 'U_REQUESTER',
        GitHubUrls: null,
        State: 'scheduled',
      }];
      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        MessageMetadataById: {
          [`C_REMINDERS:${MessageTS}`]: {
            event_type: 'sleuth-ai-reminder-ids',
            event_payload: { ReminderIDs: JSON.stringify([ReminderID]) },
          },
        },
      });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateReactionAddedAsync({
          user: 'U_REQUESTER',
          reaction: 'wastebasket',
          item: { channel: 'C_REMINDERS', ts: MessageTS },
        });

        const PersistedReminders = JSON.parse(await fs.readFile(RuntimePaths.remindersFilePath, 'utf8'));

        expect(WasHandled).toBe(true);
        expect(PersistedReminders).toEqual([]);
        expect(SlackApp.DeletedMessages).toEqual([{ channel: 'C_REMINDERS', ts: MessageTS }]);
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });
  });

  describe('semantic gate for short "this" messages', () => {
    afterEach(() => {
      MockWorkspaceAI.mockReset();
    });

    describe('false positive prevention: blocks vague "this" messages', () => {
      test('rejects short message with demonstrative "this" and weak trigger "by"', async () => {
        const SlackApp = new MockSlackApp({ WorkspaceInfo: TestWorkspaceInfo });
        const Reminders = new RemindersModule(SlackApp);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_TEST',
          user: 'USENDER01',
          text: `${SlackApp.AppMentionString} <@UASSIGNEE1> can you look at this by then`,
        });

        expect(WasHandled).toBe(false);
        expect(SlackApp.SentMessages).toHaveLength(0);
        const GateLog = SlackApp.Logger.InfoMessages.find(m => m.includes('semantic gate'));
        expect(GateLog).toBeDefined();
      });

      test('rejects short message with "this" and weak trigger "before"', async () => {
        const SlackApp = new MockSlackApp({ WorkspaceInfo: TestWorkspaceInfo });
        const Reminders = new RemindersModule(SlackApp);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_TEST',
          user: 'USENDER01',
          text: `${SlackApp.AppMentionString} <@UASSIGNEE1> this was done before`,
        });

        expect(WasHandled).toBe(false);
        expect(SlackApp.SentMessages).toHaveLength(0);
      });

      test('rejects short message "handle this by the way"', async () => {
        const SlackApp = new MockSlackApp({ WorkspaceInfo: TestWorkspaceInfo });
        const Reminders = new RemindersModule(SlackApp);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_TEST',
          user: 'USENDER01',
          text: `${SlackApp.AppMentionString} <@UASSIGNEE1> handle this by the way`,
        });

        expect(WasHandled).toBe(false);
      });
    });

    describe('false negative prevention: allows "this" messages with real scheduling intent', () => {
      test('allows "this" with strong trigger "tomorrow" (passes to AI)', async () => {
        const MockProcess = ConfigureMockWorkspaceAI(MockWorkspaceAI, { recommendation: 'ignore' });
        const WorkspaceInfo = MakeWorkspaceInfo('gate_this_tomorrow');
        const SlackApp = new MockSlackApp({
          WorkspaceInfo,
          ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        });
        const Reminders = new RemindersModule(SlackApp);

        try {
          await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
          await Reminders.StartAsync(EmptyWorkspaceStats);

          await SlackApp.SimulateAppMentionAsync({
            channel: 'C_TEST',
            user: 'U_SENDER',
            text: `${SlackApp.AppMentionString} <@UASSIGNEE1> finish this by tomorrow`,
          });

          // the message passed the gate and reached the AI (even though AI said ignore).
          expect(MockProcess).toHaveBeenCalled();
          const TaskLog = SlackApp.Logger.InfoMessages.find(m => m.includes('task assignment'));
          expect(TaskLog).toBeDefined();
        } finally {
          await Reminders.StopAsync();
          await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        }
      });

      test('allows "this" with strong trigger "friday"', async () => {
        const MockProcess = ConfigureMockWorkspaceAI(MockWorkspaceAI, { recommendation: 'ignore' });
        const WorkspaceInfo = MakeWorkspaceInfo('gate_this_friday');
        const SlackApp = new MockSlackApp({
          WorkspaceInfo,
          ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        });
        const Reminders = new RemindersModule(SlackApp);

        try {
          await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
          await Reminders.StartAsync(EmptyWorkspaceStats);

          await SlackApp.SimulateAppMentionAsync({
            channel: 'C_TEST',
            user: 'U_SENDER',
            text: `${SlackApp.AppMentionString} <@UASSIGNEE1> finish this by friday`,
          });

          expect(MockProcess).toHaveBeenCalled();
        } finally {
          await Reminders.StopAsync();
          await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        }
      });

      test('allows "this" with strong trigger "eod"', async () => {
        const MockProcess = ConfigureMockWorkspaceAI(MockWorkspaceAI, { recommendation: 'ignore' });
        const WorkspaceInfo = MakeWorkspaceInfo('gate_this_eod');
        const SlackApp = new MockSlackApp({
          WorkspaceInfo,
          ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        });
        const Reminders = new RemindersModule(SlackApp);

        try {
          await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
          await Reminders.StartAsync(EmptyWorkspaceStats);

          await SlackApp.SimulateAppMentionAsync({
            channel: 'C_TEST',
            user: 'U_SENDER',
            text: `${SlackApp.AppMentionString} <@UASSIGNEE1> finish this by eod`,
          });

          expect(MockProcess).toHaveBeenCalled();
        } finally {
          await Reminders.StopAsync();
          await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        }
      });

      test('allows "this week" as a time reference (not demonstrative)', async () => {
        const MockProcess = ConfigureMockWorkspaceAI(MockWorkspaceAI, { recommendation: 'ignore' });
        const WorkspaceInfo = MakeWorkspaceInfo('gate_this_week');
        const SlackApp = new MockSlackApp({
          WorkspaceInfo,
          ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        });
        const Reminders = new RemindersModule(SlackApp);

        try {
          await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
          await Reminders.StartAsync(EmptyWorkspaceStats);

          await SlackApp.SimulateAppMentionAsync({
            channel: 'C_TEST',
            user: 'U_SENDER',
            text: `${SlackApp.AppMentionString} <@UASSIGNEE1> do this this week`,
          });

          expect(MockProcess).toHaveBeenCalled();
        } finally {
          await Reminders.StopAsync();
          await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        }
      });

      test('allows longer message with "this" even with weak trigger', async () => {
        const MockProcess = ConfigureMockWorkspaceAI(MockWorkspaceAI, { recommendation: 'ignore' });
        const WorkspaceInfo = MakeWorkspaceInfo('gate_this_long');
        const SlackApp = new MockSlackApp({
          WorkspaceInfo,
          ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        });
        const Reminders = new RemindersModule(SlackApp);

        try {
          await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
          await Reminders.StartAsync(EmptyWorkspaceStats);

          await SlackApp.SimulateAppMentionAsync({
            channel: 'C_TEST',
            user: 'U_SENDER',
            text: `${SlackApp.AppMentionString} <@UASSIGNEE1> please review this PR and make sure the deployment pipeline is updated by then with the new config`,
          });

          // long message (>8 words) passes the gate even with weak "by" trigger.
          expect(MockProcess).toHaveBeenCalled();
        } finally {
          await Reminders.StopAsync();
          await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        }
      });

      test('allows "this morning" as a time reference', async () => {
        const MockProcess = ConfigureMockWorkspaceAI(MockWorkspaceAI, { recommendation: 'ignore' });
        const WorkspaceInfo = MakeWorkspaceInfo('gate_this_morning');
        const SlackApp = new MockSlackApp({
          WorkspaceInfo,
          ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        });
        const Reminders = new RemindersModule(SlackApp);

        try {
          await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
          await Reminders.StartAsync(EmptyWorkspaceStats);

          await SlackApp.SimulateAppMentionAsync({
            channel: 'C_TEST',
            user: 'U_SENDER',
            text: `${SlackApp.AppMentionString} <@UASSIGNEE1> do this this morning`,
          });

          expect(MockProcess).toHaveBeenCalled();
        } finally {
          await Reminders.StopAsync();
          await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        }
      });
    });

  describe('thread context lookup: resolves "this" from preceding thread message', () => {
      test('fetches preceding thread message and passes combined text to AI', async () => {
        const MockProcess = ConfigureMockWorkspaceAI(MockWorkspaceAI, { recommendation: 'ignore' });
        const WorkspaceInfo = MakeWorkspaceInfo('gate_thread_context');
        const ParentTS = '1700000000.000001';
        const PrecedingTS = '1700000000.000002';
        const MentionTS = '1700000000.000003';

        const SlackApp = new MockSlackApp({
          WorkspaceInfo,
          ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
          ThreadMessagesById: {
            [`C_TEST:${ParentTS}`]: [
              { user: 'UAUTHOR01', text: 'Deploy the new API changes to staging', ts: ParentTS, bot_id: undefined, reactions: [] },
              { user: 'UAUTHOR01', text: 'Make sure the health checks pass first', ts: PrecedingTS, bot_id: undefined, reactions: [] },
              { user: 'USENDER01', text: `${undefined} <@UASSIGNEE1> handle this by then`, ts: MentionTS, bot_id: undefined, reactions: [] },
            ],
          },
        });
        const Reminders = new RemindersModule(SlackApp);

        try {
          await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
          await Reminders.StartAsync(EmptyWorkspaceStats);

          // simulate as a thread reply.
          await SlackApp.SimulateAppMentionAsync({
            channel: 'C_TEST',
            user: 'USENDER01',
            ts: MentionTS,
            thread_ts: ParentTS,
            text: `${SlackApp.AppMentionString} <@UASSIGNEE1> handle this by then`,
          });

          // the gate resolved "this" from the preceding thread message and passed combined text to AI.
          expect(MockProcess).toHaveBeenCalled();
          const FirstCallArg = MockProcess.mock.calls[0][0];
          expect(FirstCallArg).toContain('Make sure the health checks pass first');
          const ContextLog = SlackApp.Logger.InfoMessages.find(m => m.includes('resolved "this" from preceding thread message'));
          expect(ContextLog).toBeDefined();
        } finally {
          await Reminders.StopAsync();
          await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        }
      });

      test('falls back past bot messages to the nearest earlier human message', async () => {
        const MockProcess = ConfigureMockWorkspaceAI(MockWorkspaceAI, { recommendation: 'ignore' });
        const WorkspaceInfo = MakeWorkspaceInfo('gate_thread_bot');
        const ParentTS = '1700000000.000001';
        const BotTS = '1700000000.000002';
        const MentionTS = '1700000000.000003';

        const SlackApp = new MockSlackApp({
          WorkspaceInfo,
          ThreadMessagesById: {
            [`C_TEST:${ParentTS}`]: [
              { user: 'UAUTHOR01', text: 'Original task message', ts: ParentTS, bot_id: undefined, reactions: [] },
              { user: 'UBOTUSER1', text: 'Automated deploy notification', ts: BotTS, bot_id: 'B12345', reactions: [] },
              { user: 'USENDER01', text: `placeholder <@UASSIGNEE1> handle this by then`, ts: MentionTS, bot_id: undefined, reactions: [] },
            ],
          },
        });
        const Reminders = new RemindersModule(SlackApp);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_TEST',
          user: 'USENDER01',
          ts: MentionTS,
          thread_ts: ParentTS,
          text: `${SlackApp.AppMentionString} <@UASSIGNEE1> handle this by then`,
        });

        expect(WasHandled).toBe(false);
        expect(MockProcess).toHaveBeenCalled();
        expect(MockProcess.mock.calls[0][0]).toContain('Original task message');
      });

      test('skips thread context when mention is the first message in the thread', async () => {
        const ParentTS = '1700000000.000001';

        const SlackApp = new MockSlackApp({
          WorkspaceInfo: TestWorkspaceInfo,
          ThreadMessagesById: {
            [`C_TEST:${ParentTS}`]: [
              { user: 'USENDER01', text: `placeholder <@UASSIGNEE1> handle this by then`, ts: ParentTS, bot_id: undefined, reactions: [] },
            ],
          },
        });
        const Reminders = new RemindersModule(SlackApp);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_TEST',
          user: 'USENDER01',
          ts: ParentTS,
          thread_ts: ParentTS,
          text: `${SlackApp.AppMentionString} <@UASSIGNEE1> handle this by then`,
        });

        expect(WasHandled).toBe(false);
        const SkipLog = SlackApp.Logger.InfoMessages.find(m => m.includes('not usable'));
        expect(SkipLog).toBeDefined();
      });

      test('top-level short "this" message still skips without thread lookup', async () => {
        const SlackApp = new MockSlackApp({ WorkspaceInfo: TestWorkspaceInfo });
        const Reminders = new RemindersModule(SlackApp);
        await Reminders.StartAsync(EmptyWorkspaceStats);

        const WasHandled = await SlackApp.SimulateAppMentionAsync({
          channel: 'C_TEST',
          user: 'USENDER01',
          text: `${SlackApp.AppMentionString} <@UASSIGNEE1> handle this by then`,
        });

        expect(WasHandled).toBe(false);
        const GateLog = SlackApp.Logger.InfoMessages.find(m => m.includes('short message with demonstrative'));
        expect(GateLog).toBeDefined();
      });
    });
  });

  describe('Phase 2 enriched-thread safety check', () => {
    test('suppresses a weak acknowledgment thread reply even when enriched context and AI both suggest scheduling', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('phase2_enriched_weak_reply');
      const ParentTS = '1700000000.000001';
      const ReplyTS = '1700000000.000002';
      const MockProcess = ConfigureMockWorkspaceAI(MockWorkspaceAI, {
        recommendation: 'schedule',
        reminderMessage: 'Reactivate the plugin',
        schedulingTrigger: 'asap',
      });

      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        ChannelCreatorsById: { C_GENERAL: 'U_CREATOR' },
        ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        ThreadMessagesById: {
          [`C_GENERAL:${ParentTS}`]: [
            {
              user: 'U_OTHER',
              text: 'Please file ticket for GoAffPro and reactivate that plugin as soon as possible.',
              ts: ParentTS,
              bot_id: undefined,
              reactions: [],
            },
            {
              user: 'U_SENDER',
              text: "Ok, I'll keep that in mind when I get to that plugin. I'm assuming the goal is to be able to reactivate that plugin asap.",
              ts: ReplyTS,
              bot_id: undefined,
              reactions: [],
            },
          ],
        },
      });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);
        await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_CREATOR',
          text: `${SlackApp.AppMentionString} enable reminders`,
        });
        SlackApp.SentMessages = [];

        const WasHandled = await SlackApp.SimulateMessageAsync({
          channel: 'C_GENERAL',
          user: 'U_SENDER',
          ts: ReplyTS,
          thread_ts: ParentTS,
          text: "Ok, I'll keep that in mind when I get to that plugin. I'm assuming the goal is to be able to reactivate that plugin asap.",
        });

        expect(WasHandled).toBe(true);
        expect(MockProcess).not.toHaveBeenCalled();
        expect(SlackApp.SentMessages).toHaveLength(0);
        await expect(
          fs.readFile(GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME).remindersFilePath, 'utf8')
        ).rejects.toThrow();
        expect(
          SlackApp.Logger.InfoMessages.some((ArgMessage) =>
            ArgMessage.includes('reminder enrichment guard:') &&
            ArgMessage.includes('path=hypothetical_subordinate_reply') &&
            ArgMessage.includes('temporal_trigger="asap"')
          )
        ).toBe(true);
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('keeps a real enriched commitment schedulable after the safety check', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('phase2_enriched_real_commitment');
      const ParentTS = '1700000000.000001';
      const ReplyTS = '1700000000.000002';
      const MockProcess = ConfigureMockWorkspaceAI(MockWorkspaceAI, {
        recommendation: 'schedule',
        reminderMessage: 'Handle the deployment pipeline',
        schedulingTrigger: 'tomorrow morning',
      });

      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        ChannelCreatorsById: { C_GENERAL: 'U_CREATOR' },
        ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        ThreadMessagesById: {
          [`C_GENERAL:${ParentTS}`]: [
            {
              user: 'U_OTHER',
              text: 'The deployment pipeline needs to be fixed.',
              ts: ParentTS,
              bot_id: undefined,
              reactions: [],
            },
            {
              user: 'U_SENDER',
              text: "I'll handle it tomorrow morning.",
              ts: ReplyTS,
              bot_id: undefined,
              reactions: [],
            },
          ],
        },
      });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);
        await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_CREATOR',
          text: `${SlackApp.AppMentionString} enable reminders`,
        });
        SlackApp.SentMessages = [];

        const WasHandled = await SlackApp.SimulateMessageAsync({
          channel: 'C_GENERAL',
          user: 'U_SENDER',
          ts: ReplyTS,
          thread_ts: ParentTS,
          text: "I'll handle it tomorrow morning.",
        });

        expect(WasHandled).toBe(true);
        expect(MockProcess).toHaveBeenCalled();
        const Persisted = JSON.parse(
          await fs.readFile(GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME).remindersFilePath, 'utf8')
        );
        expect(Persisted).toHaveLength(1);
        expect(Persisted[0].ReminderMessageText).toContain(">I'll handle it tomorrow morning.");
        expect(Persisted[0].ReminderMessageText).toContain("• I'll handle it tomorrow morning.");
        expect(Persisted[0].ReminderMessageText).not.toContain('The deployment pipeline needs to be fixed.');
        expect(
          SlackApp.Logger.InfoMessages.some((ArgMessage) =>
            ArgMessage.includes('reminder enriched-reply safety check:') &&
            ArgMessage.includes('temporal_trigger="tomorrow"') &&
            ArgMessage.includes('weak_live_reply=no')
          )
        ).toBe(true);
        expect(
          SlackApp.Logger.InfoMessages.some((ArgMessage) =>
            ArgMessage.includes('reminder display source:') &&
            ArgMessage.includes('quote_source=live_reply') &&
            ArgMessage.includes('task_source=live_reply_verbatim')
          )
        ).toBe(true);
        expect(SlackApp.SentMessages.some((ArgMessage) => ArgMessage.text.includes('Slack reminder has been scheduled'))).toBe(true);
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });
  });

  describe('Phase 3 display/source-text separation', () => {
    test('enriched scheduling still quotes only the live reply when synthesis is ON', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('phase3_enriched_quote_live_reply');
      const ParentTS = '1700000000.000001';
      const ReplyTS = '1700000000.000002';
      const MockProcess = ConfigureMockWorkspaceAI(MockWorkspaceAI, {
        recommendation: 'schedule',
        reminderMessage: 'Handle the deployment pipeline',
        schedulingTrigger: 'tomorrow morning',
      });

      MockWorkspaceAI.mockImplementation(() => ({
        ProcessMessageWithJsonResponseAsync: MockProcess,
        ProcessMessageWithTextResponseAsync: jest.fn().mockResolvedValue('mock text response'),
        get ComplexModelName() { return 'gpt-4o'; },
        get DefaultModelName() { return 'gpt-4o-mini'; },
        set DefaultModelName(_) {},
      }));

      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        ChannelCreatorsById: { C_GENERAL: 'U_CREATOR' },
        ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        ThreadMessagesById: {
          [`C_GENERAL:${ParentTS}`]: [
            {
              user: 'U_OTHER',
              text: 'The deployment pipeline needs to be fixed.',
              ts: ParentTS,
              bot_id: undefined,
              reactions: [],
            },
            {
              user: 'U_SENDER',
              text: "I'll handle it tomorrow morning.",
              ts: ReplyTS,
              bot_id: undefined,
              reactions: [],
            },
          ],
        },
      });
      const Reminders = new RemindersModule(SlackApp);
      const PriorSynthesisFlag = process.env.REMINDER_TEXT_SYNTHESIS;
      process.env.REMINDER_TEXT_SYNTHESIS = 'on';

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);
        await SlackApp.SimulateAppMentionAsync({
          channel: 'C_GENERAL',
          user: 'U_CREATOR',
          text: `${SlackApp.AppMentionString} enable reminders`,
        });
        SlackApp.SentMessages = [];

        const WasHandled = await SlackApp.SimulateMessageAsync({
          channel: 'C_GENERAL',
          user: 'U_SENDER',
          ts: ReplyTS,
          thread_ts: ParentTS,
          text: "I'll handle it tomorrow morning.",
        });

        expect(WasHandled).toBe(true);
        const Persisted = JSON.parse(
          await fs.readFile(GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME).remindersFilePath, 'utf8')
        );
        expect(Persisted).toHaveLength(1);
        expect(Persisted[0].ReminderMessageText).toContain(">I'll handle it tomorrow morning.");
        expect(Persisted[0].ReminderMessageText).toContain('• Handle the deployment pipeline');
        expect(Persisted[0].ReminderMessageText).not.toContain('>The deployment pipeline needs to be fixed.');
        expect(
          SlackApp.Logger.InfoMessages.some((ArgMessage) =>
            ArgMessage.includes('reminder display source:') &&
            ArgMessage.includes('quote_source=live_reply') &&
            ArgMessage.includes('task_source=ai_synthesized_task_title')
          )
        ).toBe(true);
      } finally {
        if(PriorSynthesisFlag === undefined) delete process.env.REMINDER_TEXT_SYNTHESIS;
        else process.env.REMINDER_TEXT_SYNTHESIS = PriorSynthesisFlag;
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });
  });

  // ── STARTUP WITH STALE REMINDERS ──────────────────────────────────────────────────────────────
  // Regression tests for the cascade loop bug (v1.4.57) and the FSM-driven two-pass check cycle
  // (v1.4.58). These tests simulate an app restart where persisted reminders have stale due dates
  // and verify that the FSM + rescheduling logic prevents duplicate Slack posts.
  //
  // Pattern: seed stale reminders to disk → StartAsync (loads them) → trigger "process reminders
  // now" via SimulateAppMentionAsync → assert on MockSlackApp.SentMessages count and persisted
  // reminder state on disk.
  describe('startup with stale reminders', () => {
    /**
     * Helper: read persisted reminders back from disk with date revival.
     * @param {string} ArgFilePath Path to the reminders JSON file.
     * @returns {Promise<import('../src/reminders-module').ReminderInfo[]>}
     */
    async function ReadPersistedRemindersAsync(ArgFilePath) {
      const Raw = await fs.readFile(ArgFilePath, 'utf8');
      return JSON.parse(Raw, (ArgKey, ArgValue) =>
        (ArgKey === 'CreatedOn' || ArgKey === 'ShouldPostOn') ? new Date(ArgValue) : ArgValue
      );
    }

    test('reminder 5 days overdue posts exactly once and reschedules to tomorrow', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('stale_single_reminder');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);

      // seed a reminder that was due 5 days ago.
      const FiveDaysAgo = new Date();
      FiveDaysAgo.setUTCDate(FiveDaysAgo.getUTCDate() - 5);
      FiveDaysAgo.setUTCHours(9, 0, 0, 0);

      const ReminderSeed = [
        {
          ReminderID: 'stale-0001-0001-0001-000000000001',
          CreatedOn: '2026-03-15T09:00:00.000Z',
          ShouldPostOn: FiveDaysAgo.toISOString(),
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalMessageID: '1773990000.100001',
          OriginalSenderID: 'U_SENDER',
          ReminderMessageText: 'Follow up on overdue invoice',
          IgnoreSnooze: false,
          OriginalChannelName: 'general',
          AssigneeID: 'U_SENDER',
          GitHubUrls: null,
          State: 'scheduled',
        },
      ];

      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        // trigger process reminders (calls CheckRemindersAsync(true)).
        await SlackApp.SimulateAppMentionAsync({
          channel: 'C_REMINDERS',
          user: 'U_SENDER',
          text: `${SlackApp.AppMentionString} process reminders now`,
        });

        // expect: 1 reminder post in target channel + 1 in original channel + 1 confirmation message.
        // target and original are different channels so both get the post.
        const ReminderPosts = SlackApp.SentMessages.filter(m => m.text.includes('Follow up on overdue invoice'));
        expect(ReminderPosts).toHaveLength(2); // target + original channel.

        // verify rescheduled date on disk is tomorrow (not just +1 from the stale date).
        const Persisted = await ReadPersistedRemindersAsync(RuntimePaths.remindersFilePath);
        expect(Persisted).toHaveLength(1);
        expect(Persisted[0].State).toBe('scheduled');

        const Tomorrow = new Date();
        Tomorrow.setUTCDate(Tomorrow.getUTCDate() + 1);
        expect(Persisted[0].ShouldPostOn.getUTCDate()).toBe(Tomorrow.getUTCDate());
        expect(Persisted[0].ShouldPostOn.getUTCMonth()).toBe(Tomorrow.getUTCMonth());
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('multiple stale reminders each post once without cascade flooding', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('stale_multiple_reminders');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);

      // seed 3 reminders overdue by different amounts.
      const MakeStaleSeed = (ArgID, ArgDaysAgo, ArgMessage) => {
        const DueDate = new Date();
        DueDate.setUTCDate(DueDate.getUTCDate() - ArgDaysAgo);
        DueDate.setUTCHours(9, 0, 0, 0);
        return {
          ReminderID: ArgID,
          CreatedOn: '2026-03-10T09:00:00.000Z',
          ShouldPostOn: DueDate.toISOString(),
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_REMINDERS', // same channel to simplify count (1 post per reminder).
          OriginalMessageID: `1773990000.${ArgID.slice(-6)}`,
          OriginalSenderID: 'U_SENDER',
          ReminderMessageText: ArgMessage,
          IgnoreSnooze: false,
          OriginalChannelName: 'reminders',
          AssigneeID: 'U_SENDER',
          GitHubUrls: null,
          State: 'scheduled',
        };
      };

      const ReminderSeed = [
        MakeStaleSeed('stale-multi-0001-0001-000000000001', 2, 'Task A overdue 2 days'),
        MakeStaleSeed('stale-multi-0001-0001-000000000002', 7, 'Task B overdue 7 days'),
        MakeStaleSeed('stale-multi-0001-0001-000000000003', 14, 'Task C overdue 14 days'),
      ];

      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        // first trigger.
        await SlackApp.SimulateAppMentionAsync({
          channel: 'C_REMINDERS',
          user: 'U_SENDER',
          text: `${SlackApp.AppMentionString} process reminders now`,
        });

        // target === original so each reminder posts once. Plus 1 confirmation message.
        const TaskAPosts = SlackApp.SentMessages.filter(m => m.text.includes('Task A overdue'));
        const TaskBPosts = SlackApp.SentMessages.filter(m => m.text.includes('Task B overdue'));
        const TaskCPosts = SlackApp.SentMessages.filter(m => m.text.includes('Task C overdue'));
        expect(TaskAPosts).toHaveLength(1);
        expect(TaskBPosts).toHaveLength(1);
        expect(TaskCPosts).toHaveLength(1);

        // verify all reminders rescheduled to tomorrow on disk after the first cycle.
        const Persisted = await ReadPersistedRemindersAsync(RuntimePaths.remindersFilePath);
        expect(Persisted).toHaveLength(3);
        const Tomorrow = new Date();
        Tomorrow.setUTCDate(Tomorrow.getUTCDate() + 1);
        for(const Reminder of Persisted) {
          expect(Reminder.State).toBe('scheduled');
          expect(Reminder.ShouldPostOn.getUTCDate()).toBe(Tomorrow.getUTCDate());
        }
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('stale reminder with IgnoreSnooze reset to false after posting', async () => {
      // verifies that after a stale reminder posts, IgnoreSnooze is reset to false so that
      // future check cycles respect snooze policy (the v1.4.57 fix included this reset).
      const WorkspaceInfo = MakeWorkspaceInfo('stale_snooze_reset');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);

      const ThreeDaysAgo = new Date();
      ThreeDaysAgo.setUTCDate(ThreeDaysAgo.getUTCDate() - 3);
      ThreeDaysAgo.setUTCHours(9, 0, 0, 0);

      const ReminderSeed = [
        {
          ReminderID: 'stale-snooze-0001-0001-000000000001',
          CreatedOn: '2026-03-15T09:00:00.000Z',
          ShouldPostOn: ThreeDaysAgo.toISOString(),
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_REMINDERS',
          OriginalMessageID: '1773990000.200001',
          OriginalSenderID: 'U_SENDER',
          ReminderMessageText: 'Snooze reset verification task',
          IgnoreSnooze: true, // start with snooze bypass active.
          OriginalChannelName: 'reminders',
          AssigneeID: 'U_SENDER',
          GitHubUrls: null,
          State: 'scheduled',
        },
      ];

      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        await SlackApp.SimulateAppMentionAsync({
          channel: 'C_REMINDERS',
          user: 'U_SENDER',
          text: `${SlackApp.AppMentionString} process reminders now`,
        });

        // verify IgnoreSnooze was reset to false after posting so future cycles respect snooze.
        const Persisted = await ReadPersistedRemindersAsync(RuntimePaths.remindersFilePath);
        expect(Persisted).toHaveLength(1);
        expect(Persisted[0].IgnoreSnooze).toBe(false);
        expect(Persisted[0].State).toBe('scheduled');
        expect(Persisted[0].ShouldPostOn > new Date()).toBe(true);
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('legacy reminder without State field loads and processes correctly', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('stale_legacy_no_state');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);

      // seed a legacy reminder with no State field (pre-FSM).
      const TwoDaysAgo = new Date();
      TwoDaysAgo.setUTCDate(TwoDaysAgo.getUTCDate() - 2);
      TwoDaysAgo.setUTCHours(9, 0, 0, 0);

      const ReminderSeed = [
        {
          ReminderID: 'stale-legacy-0001-0001-000000000001',
          CreatedOn: '2026-03-15T09:00:00.000Z',
          ShouldPostOn: TwoDaysAgo.toISOString(),
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_REMINDERS',
          OriginalMessageID: '1773990000.300001',
          OriginalSenderID: 'U_SENDER',
          ReminderMessageText: 'Legacy reminder without state',
          IgnoreSnooze: false,
          OriginalChannelName: 'reminders',
          AssigneeID: 'U_SENDER',
          GitHubUrls: null,
          // intentionally omitting State to simulate legacy data.
        },
      ];

      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        await SlackApp.SimulateAppMentionAsync({
          channel: 'C_REMINDERS',
          user: 'U_SENDER',
          text: `${SlackApp.AppMentionString} process reminders now`,
        });

        // should post exactly once despite missing State field (backfilled to 'scheduled' on load).
        const ReminderPosts = SlackApp.SentMessages.filter(m => m.text.includes('Legacy reminder without state'));
        expect(ReminderPosts).toHaveLength(1);

        // verify state was properly assigned and reminder rescheduled.
        const Persisted = await ReadPersistedRemindersAsync(RuntimePaths.remindersFilePath);
        expect(Persisted).toHaveLength(1);
        expect(Persisted[0].State).toBe('scheduled');
        expect(Persisted[0].ShouldPostOn > new Date()).toBe(true);
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('reminder persisted in legacy due state is promoted to overdue and posts', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('stale_legacy_due_state');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);

      // seed a reminder stuck in legacy 'due' state.
      const OneDayAgo = new Date();
      OneDayAgo.setUTCDate(OneDayAgo.getUTCDate() - 1);
      OneDayAgo.setUTCHours(9, 0, 0, 0);

      const ReminderSeed = [
        {
          ReminderID: 'stale-due-0001-0001-000000000001',
          CreatedOn: '2026-03-15T09:00:00.000Z',
          ShouldPostOn: OneDayAgo.toISOString(),
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_REMINDERS',
          OriginalMessageID: '1773990000.400001',
          OriginalSenderID: 'U_SENDER',
          ReminderMessageText: 'Legacy due state reminder',
          IgnoreSnooze: false,
          OriginalChannelName: 'reminders',
          AssigneeID: 'U_SENDER',
          GitHubUrls: null,
          State: 'due',
        },
      ];

      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        await SlackApp.SimulateAppMentionAsync({
          channel: 'C_REMINDERS',
          user: 'U_SENDER',
          text: `${SlackApp.AppMentionString} process reminders now`,
        });

        // legacy 'due' is promoted to 'overdue' on load, which the post pass picks up.
        const ReminderPosts = SlackApp.SentMessages.filter(m => m.text.includes('Legacy due state reminder'));
        expect(ReminderPosts).toHaveLength(1);

        const Persisted = await ReadPersistedRemindersAsync(RuntimePaths.remindersFilePath);
        expect(Persisted).toHaveLength(1);
        expect(Persisted[0].State).toBe('scheduled');
        expect(Persisted[0].ShouldPostOn > new Date()).toBe(true);
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });
  });

  // ── TIME-DRIVEN CHECK CYCLE (natural, non-forced) ─────────────────────────────────────────────
  // The 'startup with stale reminders' tests above trigger checks via the "process reminders now"
  // command, which calls #CheckRemindersAsync(true) — FORCE mode. Force mode deliberately bypasses
  // BOTH the due-time gate (`now >= ShouldPostOn`) AND the snooze-day gate, so neither is exercised
  // by that path. These tests drive the REAL recursive 30s setTimeout loop (a non-forced
  // #CheckRemindersAsync(false)) under jest fake timers, advancing the clock with
  // jest.setSystemTime + advanceTimersByTimeAsync so the natural time/snooze gating is covered.
  // This is the cycle the event-sourced core (P3) will emit lifecycle events from, so the harness
  // must be able to drive it without a live Slack workspace.
  describe('time-driven check cycle (fake timers, natural non-forced cycle)', () => {
    // Mirrors RemindersModule.#ReminderCheckInterval (30s). One advance == one natural check cycle.
    const ReminderCheckIntervalMs = 30000;

    /**
     * Read persisted reminders back from disk with date revival.
     *
     * Flushes the module's save chain first. Since GH-12 a save is a crash-atomic write — roughly
     * eight syscalls (open, write, fsync, close, rename, then the parent directory) where it used to
     * be a single `fs.writeFile` — so it no longer reliably completes inside one
     * `advanceTimersByTimeAsync` flush. These assertions are about persisted state, so they must
     * await durability explicitly rather than assume it.
     * @param {any} ArgModule Reminders module whose pending saves must land first.
     * @param {string} ArgFilePath Path to the reminders JSON file.
     * @returns {Promise<import('../src/reminders-module').ReminderInfo[]>}
     */
    async function ReadPersistedAsync(ArgModule, ArgFilePath) {
      await ArgModule.FlushRemindersAsync();
      const Raw = await fs.readFile(ArgFilePath, 'utf8');
      return JSON.parse(Raw, (ArgKey, ArgValue) =>
        (ArgKey === 'CreatedOn' || ArgKey === 'ShouldPostOn') ? new Date(ArgValue) : ArgValue
      );
    }

    test('due-time gate: a scheduled reminder does not post before its due time, then posts after — driven by the timer, not force', async () => {
      jest.useFakeTimers();
      // Wednesday 2026-06-10 17:00 UTC (== 10:00 America/Los_Angeles). No SNOOZE_DAYS configured,
      // so snooze never applies here — this isolates the due-time gate.
      const BaseTime = new Date('2026-06-10T17:00:00.000Z');
      jest.setSystemTime(BaseTime);

      const WorkspaceInfo = MakeWorkspaceInfo('timer_due_boundary');
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);

      // Due 45s in the FUTURE: not due at the 1st cycle (+30s), due at the 2nd (+60s).
      const DueAt = new Date(BaseTime.getTime() + 45000);
      const ReminderSeed = [{
        ReminderID: 'timer-due-0001-0001-000000000001',
        CreatedOn: BaseTime.toISOString(),
        ShouldPostOn: DueAt.toISOString(),
        TargetChannelID: 'C_REMINDERS',
        OriginalChannelID: 'C_REMINDERS', // same channel -> exactly one post.
        OriginalMessageID: '1773990000.500001',
        OriginalSenderID: 'U_SENDER',
        ReminderMessageText: 'Timer-driven due boundary task',
        IgnoreSnooze: false,
        OriginalChannelName: 'reminders',
        AssigneeID: 'U_SENDER',
        GitHubUrls: null,
        State: 'scheduled',
      }];

      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        // ── BEFORE due: one natural cycle at now = Base + 30s < DueAt -> no post, still scheduled.
        await jest.advanceTimersByTimeAsync(ReminderCheckIntervalMs);
        expect(SlackApp.SentMessages.filter(m => m.text.includes('Timer-driven due boundary task'))).toHaveLength(0);
        let Persisted = await ReadPersistedAsync(Reminders, RuntimePaths.remindersFilePath);
        expect(Persisted[0].State).toBe('scheduled');

        // ── AFTER due: second natural cycle at now = Base + 60s >= DueAt -> posts, then reschedules.
        await jest.advanceTimersByTimeAsync(ReminderCheckIntervalMs);
        expect(SlackApp.SentMessages.filter(m => m.text.includes('Timer-driven due boundary task'))).toHaveLength(1);
        Persisted = await ReadPersistedAsync(Reminders, RuntimePaths.remindersFilePath);
        expect(Persisted[0].State).toBe('scheduled'); // posted -> rescheduled to next day -> scheduled.
        expect(Persisted[0].ShouldPostOn.getTime()).toBeGreaterThan(DueAt.getTime());
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        jest.useRealTimers();
      }
    });

    test('snooze-day gate: on a snooze day a due reminder is held and advanced, while IgnoreSnooze bypasses and posts', async () => {
      jest.useFakeTimers();
      // Saturday 2026-06-13 20:00 UTC (== 13:00 America/Los_Angeles, PDT) -> a configured snooze day.
      const BaseTime = new Date('2026-06-13T20:00:00.000Z');
      jest.setSystemTime(BaseTime);

      const WorkspaceInfo = { ...MakeWorkspaceInfo('timer_snooze_day'), SNOOZE_DAYS: ['saturday', 'sunday'] };
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);

      // Both due 1h in the PAST (overdue, within the 24h auto-post window) so they reach the post pass.
      const DueAt = new Date(BaseTime.getTime() - 60 * 60 * 1000).toISOString();
      const MakeSeed = (ArgId, ArgText, ArgIgnoreSnooze) => ({
        ReminderID: ArgId,
        CreatedOn: '2026-06-12T09:00:00.000Z',
        ShouldPostOn: DueAt,
        TargetChannelID: 'C_REMINDERS',
        OriginalChannelID: 'C_REMINDERS',
        OriginalMessageID: `1773990000.${ArgId.slice(-6)}`,
        OriginalSenderID: 'U_SENDER',
        ReminderMessageText: ArgText,
        IgnoreSnooze: ArgIgnoreSnooze,
        OriginalChannelName: 'reminders',
        AssigneeID: 'U_SENDER',
        GitHubUrls: null,
        State: 'scheduled',
      });
      const ReminderSeed = [
        MakeSeed('timer-snooze-0001-0001-000000000001', 'Snoozed weekend task', false),
        MakeSeed('timer-snooze-0001-0001-000000000002', 'Urgent weekend task', true),
      ];

      const SlackApp = new MockSlackApp({ WorkspaceInfo });
      const Reminders = new RemindersModule(SlackApp);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);

        // one natural (non-forced) check cycle on the snooze day.
        await jest.advanceTimersByTimeAsync(ReminderCheckIntervalMs);

        // snooze-obeying reminder: suppressed (no post), advanced to a future non-snooze day.
        expect(SlackApp.SentMessages.filter(m => m.text.includes('Snoozed weekend task'))).toHaveLength(0);
        // IgnoreSnooze reminder: posts despite the snooze day.
        expect(SlackApp.SentMessages.filter(m => m.text.includes('Urgent weekend task'))).toHaveLength(1);

        const Persisted = await ReadPersistedAsync(Reminders, RuntimePaths.remindersFilePath);
        const Snoozed = Persisted.find(r => r.ReminderID === 'timer-snooze-0001-0001-000000000001');
        expect(Snoozed.State).toBe('scheduled');
        expect(Snoozed.ShouldPostOn.getTime()).toBeGreaterThan(BaseTime.getTime());
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        jest.useRealTimers();
      }
    });
  });

  describe('GH-27 thread-reply duplicate prevention', () => {
    test('does not schedule a second copy of a root-thread task from a later reply with incidental temporal language', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('gh27_thread_reply_duplicate');
      const ParentTS = '1786125725.780189';
      const ReplyTS = '1786127250.350799';
      const MockProcess = jest.fn().mockImplementation(async (ArgMessageText) => {
        if(ArgMessageText.includes('BASE DATE:')) {
          return {
            year: 2026,
            month: 8,
            day: 7,
            hour: 14,
            minute: 2,
            second: 0,
            rationale: 'Today at the requested time.',
          };
        }
        if(ArgMessageText.includes('"dedup_context"')) {
          return {
            recommendation: 'ignore',
            rationale: 'Both reminders ask to post some screenshots.',
          };
        }
        return {
          recommendation: 'schedule',
          rationale: 'Mock analyzer selected the root-thread task.',
          reminders: [{
            actionable_language: 'Post some screenshots',
            scheduling_trigger: 'today',
            reminder_message: 'Post some screenshots',
          }],
        };
      });

      MockWorkspaceAI.mockImplementation(() => ({
        ProcessMessageWithJsonResponseAsync: MockProcess,
        ProcessMessageWithTextResponseAsync: jest.fn().mockResolvedValue('mock text response'),
        get ComplexModelName() { return 'gpt-4o'; },
        get DefaultModelName() { return 'gpt-4o-mini'; },
        set DefaultModelName(_) {},
      }));

      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
      });
      const Reminders = new RemindersModule(SlackApp);
      const RuntimePaths = GetReminderRuntimePaths(WorkspaceInfo.WORKSPACE_NAME);

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await fs.writeFile(RuntimePaths.remindersFilePath, JSON.stringify([{
          ReminderID: '1e9e0cdc-c788-490d-abba-31f72732480d',
          CreatedOn: '2026-08-07T18:02:13.492Z',
          ShouldPostOn: '2026-08-07T21:02:10.000Z',
          TargetChannelID: 'C_REMINDERS',
          OriginalChannelID: 'C_GENERAL',
          OriginalChannelName: 'general',
          OriginalMessageID: ParentTS,
          OriginalThreadTs: null,
          OriginalSenderID: 'U_SENDER',
          ReminderMessageText: 'Post some screenshots',
          AssigneeID: null,
          GitHubUrls: null,
          IgnoreSnooze: false,
          State: 'scheduled',
        }], null, 2), 'utf8');
        await fs.writeFile(RuntimePaths.enabledChannelsFilePath, JSON.stringify(['C_GENERAL']), 'utf8');
        await Reminders.StartAsync(EmptyWorkspaceStats);
        SlackApp.SentMessages = [];

        const ReplyHandled = await SlackApp.SimulateMessageAsync({
          channel: 'C_GENERAL',
          user: 'U_SENDER',
          ts: ReplyTS,
          thread_ts: ParentTS,
          text: 'So today the broader decision remains unchanged.',
        });

        expect(ReplyHandled).toBe(false);
        expect(SlackApp.SentMessages.filter(ArgMessage => ArgMessage.text.includes('Slack reminder has been scheduled'))).toHaveLength(0);
        const Persisted = JSON.parse(await fs.readFile(RuntimePaths.remindersFilePath, 'utf8'));
        expect(Persisted).toHaveLength(1);
        expect(Persisted[0].OriginalMessageID).toBe(ParentTS);
        expect(MockProcess.mock.calls.some(([ArgMessageText]) => ArgMessageText.includes('"dedup_context"'))).toBe(true);
      } finally {
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });

    test('force scheduling bypasses semantic duplicate judgments but preserves exact-message protection', async () => {
      const WorkspaceInfo = MakeWorkspaceInfo('gh27_force_schedule_dedup_contract');
      const MessageTS = '1786127250.350799';
      ConfigureMockWorkspaceAI(MockWorkspaceAI, {
        recommendation: 'ignore',
        reminderMessage: 'Post some screenshots',
        extractedDate: { year: 2026, month: 8, day: 8, hour: 14, minute: 27, second: 0 },
      });
      const SlackApp = new MockSlackApp({
        WorkspaceInfo,
        ChannelIdsByName: { 'test-reminders': 'C_REMINDERS' },
        ThreadMessagesById: {
          [`C_GENERAL:${MessageTS}`]: [{
            user: 'U_SENDER', text: 'Post some screenshots', ts: MessageTS, bot_id: undefined, reactions: [],
          }],
        },
      });
      const Reminders = new RemindersModule(SlackApp);
      const DedupSpy = jest.spyOn(RemindersAIPipeline.prototype, 'CheckForDuplicateReminderAsync');

      try {
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
        await Reminders.StartAsync(EmptyWorkspaceStats);
        DedupSpy.mockResolvedValueOnce({
          recommendation: 'ignore',
          rationale: 'Similar task already exists in this Slack thread.',
          matched_by: 'semantic',
        });

        const SemanticDuplicateHandled = await SlackApp.SimulateReactionAddedAsync({
          user: 'U_OPERATOR', reaction: 'alarm_clock', item: { channel: 'C_GENERAL', ts: MessageTS },
        });

        expect(SemanticDuplicateHandled).toBe(true);
        expect(Reminders.GetAllReminders()).toHaveLength(1);
        expect(SlackApp.Logger.InfoMessages.some(ArgMessage =>
          ArgMessage.includes('bypassing semantic duplicate check for force-scheduled reminder')
        )).toBe(true);

        DedupSpy.mockResolvedValueOnce({
          recommendation: 'ignore',
          rationale: 'Reminder with same OriginalMessageID already exists.',
          matched_by: 'message_id',
        });

        const ExactDuplicateHandled = await SlackApp.SimulateReactionAddedAsync({
          user: 'U_OPERATOR', reaction: 'alarm_clock', item: { channel: 'C_GENERAL', ts: MessageTS },
        });

        expect(ExactDuplicateHandled).toBe(false);
        expect(Reminders.GetAllReminders()).toHaveLength(1);
        expect(SlackApp.Logger.InfoMessages.some(ArgMessage =>
          ArgMessage.includes('Force-scheduled reminder has the same OriginalMessageID. Skipping scheduling.')
        )).toBe(true);
      } finally {
        DedupSpy.mockRestore();
        await Reminders.StopAsync();
        await CleanupReminderRuntimeFilesAsync(WorkspaceInfo.WORKSPACE_NAME);
      }
    });
  });
});
