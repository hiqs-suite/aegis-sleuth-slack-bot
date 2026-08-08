'use strict';

// P3 Phase 1 (NON-authoritative) — behavioral proof that FSM lifecycle transitions are mirrored
// into the append-only event ledger (data/runtime/events/<workspace>_events.jsonl) WITHOUT
// changing transition behavior. Drives a real completion through the public FSM entry point and
// asserts (a) the transition still succeeds and (b) a ReminderCompleted event lands in the ledger.

// Assert the CURRENT schema version rather than a literal: the ledger moved to v2 in the schema
// expansion, and pinning a number here means the next bump fails a test instead of being noticed.
const { CURRENT_SCHEMA_VERSION } = require('../src/event-store');
const fs = require('fs').promises;
const path = require('path');

// Mock WorkspaceAI so StartAsync's AI pipeline construction needs no real OpenAI calls.
jest.mock('../src/workspace-ai');
const MockWorkspaceAI = require('../src/workspace-ai');
const { ConfigureMockWorkspaceAI } = require('./mocks/mock-workspace-ai');

const RemindersModule = require('../src/reminders-module');
const { MockSlackApp } = require('./mocks/mock-slack-app');

const BaseWorkspaceInfo = {
  ADMIN_EMAIL: 'admin@example.com',
  LIVE_TOKEN: 'xoxb-test',
  LIVE_SIGNING_SECRET: 'secret',
  LIVE_APP_TOKEN: 'xapp-test',
  OPENAI_API_KEY: 'sk-test',
  REMINDER_CHANNEL_NAME: 'test-reminders',
  MAIN_TIMEZONE: 'America/Los_Angeles',
};

const EmptyWorkspaceStats = {
  IncomingMessageCount: 0, IncomingMessageLength: 0,
  OutgoingMessageCount: 0, OutgoingMessageLength: 0,
  OutgoingGptMessageCount: 0, OutgoingGptMessageLength: 0,
  IncomingGptMessageCount: 0, IncomingGptMessageLength: 0,
};

const RuntimeRoot = path.join(__dirname, '..', 'data', 'runtime');

function RemindersFilePath(ArgWorkspace) {
  return path.join(RuntimeRoot, 'reminders', `${ArgWorkspace}_reminders.json`);
}
function EventsFilePath(ArgWorkspace) {
  return path.join(RuntimeRoot, 'events', `${ArgWorkspace}_events.jsonl`);
}

async function CleanupAsync(ArgWorkspace) {
  await fs.mkdir(path.join(RuntimeRoot, 'reminders'), { recursive: true });
  for(const FileName of ['reminders.json', 'reminder_counter.json', 'enabled_channels.json', 'completed.json']) {
    await fs.rm(path.join(RuntimeRoot, 'reminders', `${ArgWorkspace}_${FileName}`), { force: true });
  }
  await fs.rm(EventsFilePath(ArgWorkspace), { force: true });
}

/** Poll the ledger file until ArgPredicate(parsedLines) is satisfied (fire-and-forget append may lag). */
async function ReadLedgerUntilAsync(ArgWorkspace, ArgPredicate, ArgTimeoutMs = 2000) {
  const Deadline = Date.now() + ArgTimeoutMs;
  let Lines = [];
  while(Date.now() < Deadline) {
    let Raw = '';
    try { Raw = await fs.readFile(EventsFilePath(ArgWorkspace), 'utf8'); } catch { /* not written yet */ }
    Lines = Raw.split('\n').filter(Boolean).map(ArgLine => JSON.parse(ArgLine));
    if(ArgPredicate(Lines)) return Lines;
    await new Promise(ArgResolve => setTimeout(ArgResolve, 25));
  }
  return Lines;
}

/**
 * Poll until the ledger has the SPECIFIC event the caller is about to assert on.
 *
 * This replaces a helper that waited only for the FIRST line bearing this reminder id. That stopped
 * being a sufficient wait once v2 added a generic ReminderStateChanged to every transition: a
 * transition now writes two events, so the weaker predicate could return on the first while the one
 * under test was still in flight. It surfaced as a real full-suite failure while the same test
 * passed in isolation in 0.6s — the signature of a wait that is too weak, not of an emission that is
 * missing.
 */
function ReadLedgerForTypeAsync(ArgWorkspace, ArgReminderID, ArgType, ArgTimeoutMs = 2000) {
  return ReadLedgerUntilAsync(
    ArgWorkspace,
    ArgLines => ArgLines.some(ArgEvent => ArgEvent.reminderId === ArgReminderID && ArgEvent.type === ArgType),
    ArgTimeoutMs
  );
}

describe('P3 Phase 1 — non-authoritative event emission from the FSM', () => {
  beforeEach(() => {
    ConfigureMockWorkspaceAI(MockWorkspaceAI);
  });

  test('a completion transition is mirrored to the ledger and still succeeds', async () => {
    const WorkspaceInfo = { ...BaseWorkspaceInfo, WORKSPACE_NAME: 'IntegrationWorkspace_event_emission' };
    const Workspace = WorkspaceInfo.WORKSPACE_NAME;
    const ReminderID = '99999999-9999-9999-9999-999999999999';
    const Seed = [{
      ReminderID,
      CreatedOn: '2026-03-19T16:00:00.000Z',
      ShouldPostOn: '2026-03-20T16:00:00.000Z',
      TargetChannelID: 'C_REMINDERS',
      OriginalChannelID: 'C_GENERAL',
      OriginalMessageID: '1773990000.000099',
      OriginalSenderID: 'U_REQUESTER',
      ReminderMessageText: 'Ship the event ledger',
      IgnoreSnooze: false,
      OriginalChannelName: 'general',
      AssigneeID: 'U_REQUESTER',
      GitHubUrls: null,
      State: 'scheduled',
    }];

    const SlackApp = new MockSlackApp({ WorkspaceInfo });
    const Reminders = new RemindersModule(SlackApp);

    try {
      await CleanupAsync(Workspace);
      await fs.writeFile(RemindersFilePath(Workspace), JSON.stringify(Seed, null, 2), 'utf8');
      await Reminders.StartAsync(EmptyWorkspaceStats);

      // Drive the same transition path the white-check-mark reaction uses.
      const Completed = await Reminders.CompleteReminderByIdAsync(ReminderID, 'reaction');

      // (a) The transition behavior is unchanged: completion still succeeds and is recorded.
      expect(Completed).toBe(true);
      const Recorded = Reminders.GetCompletedRemindersBetween(0, Date.now() + 60_000);
      expect(Recorded.some(ArgRow => ArgRow.reminderId === ReminderID)).toBe(true);

      // (b) The non-authoritative ledger captured a ReminderCompleted event for this reminder.
      const Ledger = await ReadLedgerForTypeAsync(Workspace, ReminderID, 'ReminderCompleted');
      const Completion = Ledger.find(ArgEvent => ArgEvent.type === 'ReminderCompleted' && ArgEvent.reminderId === ReminderID);
      expect(Completion).toBeDefined();
      expect(Completion.workspace).toBe(Workspace);
      expect(Completion.v).toBe(CURRENT_SCHEMA_VERSION);
      expect(typeof Completion.id).toBe('string');
      expect(typeof Completion.ts).toBe('string');
      expect(Completion.payload.by).toBe('U_REQUESTER');
      expect(Completion.payload.summary).toBe('Ship the event ledger');
      expect(typeof Completion.payload.completedAt).toBe('string');
    } finally {
      await Reminders.StopAsync();
      await CleanupAsync(Workspace);
    }
  });

  test('a newly created reminder emits ReminderCreated AND a paired ReminderScheduled carrying the due date', async () => {
    const WorkspaceInfo = { ...BaseWorkspaceInfo, WORKSPACE_NAME: 'IntegrationWorkspace_event_created' };
    const Workspace = WorkspaceInfo.WORKSPACE_NAME;
    const SlackApp = new MockSlackApp({ WorkspaceInfo });
    const Reminders = new RemindersModule(SlackApp);

    try {
      await CleanupAsync(Workspace);
      await Reminders.StartAsync(EmptyWorkspaceStats);

      // CreateReminderFromListRowAsync routes through the FSM factory (#MakeScheduledReminder).
      const DueIso = '2026-07-01T16:00:00.000Z';
      const Result = await Reminders.CreateReminderFromListRowAsync({
        summary: 'Wire the scheduled event',
        dueDate: DueIso,
        targetChannelID: 'C_REMINDERS',
        assigneeID: 'U_OWNER',
        originalSenderID: 'U_OWNER',
      });
      expect(Result.ok).toBe(true);
      const ReminderID = Result.reminder.ReminderID;

      // Wait for BOTH events (they append a tick apart through the serialized write chain).
      const Ledger = await ReadLedgerUntilAsync(Workspace, ArgLines =>
        ArgLines.some(ArgEvent => ArgEvent.type === 'ReminderCreated' && ArgEvent.reminderId === ReminderID) &&
        ArgLines.some(ArgEvent => ArgEvent.type === 'ReminderScheduled' && ArgEvent.reminderId === ReminderID));

      const Created = Ledger.find(ArgEvent => ArgEvent.type === 'ReminderCreated' && ArgEvent.reminderId === ReminderID);
      const Scheduled = Ledger.find(ArgEvent => ArgEvent.type === 'ReminderScheduled' && ArgEvent.reminderId === ReminderID);
      expect(Created).toBeDefined();
      expect(Scheduled).toBeDefined();
      // The Blocker fix: replay can recover the initial due date + scheduled state from the log alone.
      expect(Scheduled.payload.dueAt).toBe(new Date(DueIso).toISOString());
      expect(Scheduled.payload.via).toBe('created');
      // Created is appended before Scheduled (deterministic per-entity stream order).
      expect(Ledger.indexOf(Created)).toBeLessThan(Ledger.indexOf(Scheduled));
    } finally {
      await Reminders.StopAsync();
      await CleanupAsync(Workspace);
    }
  });

  test('a cancellation transition emits ReminderCancelled and still cancels', async () => {
    const WorkspaceInfo = { ...BaseWorkspaceInfo, WORKSPACE_NAME: 'IntegrationWorkspace_event_cancelled' };
    const Workspace = WorkspaceInfo.WORKSPACE_NAME;
    const SlackApp = new MockSlackApp({ WorkspaceInfo });
    const Reminders = new RemindersModule(SlackApp);

    try {
      await CleanupAsync(Workspace);
      await Reminders.StartAsync(EmptyWorkspaceStats);

      const Created = await Reminders.CreateReminderFromListRowAsync({
        summary: 'Cancel me',
        dueDate: '2026-07-02T16:00:00.000Z',
        targetChannelID: 'C_REMINDERS',
        assigneeID: 'U_OWNER',
        originalSenderID: 'U_OWNER',
      });
      expect(Created.ok).toBe(true);
      const ReminderID = Created.reminder.ReminderID;

      const Cancelled = await Reminders.CancelReminderFromListAsync(ReminderID, 'list-removed');

      // Behavior unchanged: cancellation still succeeds.
      expect(Cancelled).toBe(true);

      // The ledger captured the cancellation.
      const Ledger = await ReadLedgerUntilAsync(Workspace, ArgLines =>
        ArgLines.some(ArgEvent => ArgEvent.type === 'ReminderCancelled' && ArgEvent.reminderId === ReminderID));
      const Cancellation = Ledger.find(ArgEvent => ArgEvent.type === 'ReminderCancelled' && ArgEvent.reminderId === ReminderID);
      expect(Cancellation).toBeDefined();
      expect(Cancellation.payload.reason).toBe('list-removed');
      expect(Cancellation.payload.by).toBe('U_OWNER');
    } finally {
      await Reminders.StopAsync();
      await CleanupAsync(Workspace);
    }
  });

  test('the snooze-day gate emits ReminderSnoozed through the natural (non-forced) check cycle', async () => {
    // Closes the Phase 1 deferred gap: ReminderSnoozed is only reachable via the snooze-day gate in
    // the natural 30s check cycle (force mode bypasses snooze), so it needs fake timers + a configured
    // snooze day. Mirrors the snooze-day gate test in reminders-integration.test.js, asserting the
    // ledger emission rather than the posting behavior.
    const WorkspaceInfo = {
      ...BaseWorkspaceInfo,
      WORKSPACE_NAME: 'IntegrationWorkspace_event_snoozed',
      SNOOZE_DAYS: ['saturday'],
    };
    const Workspace = WorkspaceInfo.WORKSPACE_NAME;
    const ReminderID = '88888888-8888-8888-8888-888888888888';

    // Saturday 2026-06-13 20:00 UTC -> a configured snooze day (#GetCurrentDayName uses getUTCDay()).
    const BaseTime = new Date('2026-06-13T20:00:00.000Z');
    // Due 1h in the PAST: overdue and within the 24h auto-post window, so it reaches the snooze gate.
    const DueAtIso = new Date(BaseTime.getTime() - 60 * 60 * 1000).toISOString();
    const Seed = [{
      ReminderID,
      CreatedOn: '2026-06-12T09:00:00.000Z',
      ShouldPostOn: DueAtIso,
      TargetChannelID: 'C_REMINDERS',
      OriginalChannelID: 'C_REMINDERS',
      OriginalMessageID: '1773990000.000088',
      OriginalSenderID: 'U_ASSIGNEE',
      ReminderMessageText: 'Snooze me on the weekend',
      IgnoreSnooze: false,
      OriginalChannelName: 'reminders',
      AssigneeID: 'U_ASSIGNEE',
      GitHubUrls: null,
      State: 'scheduled',
    }];

    const SlackApp = new MockSlackApp({ WorkspaceInfo });
    const Reminders = new RemindersModule(SlackApp);

    // Fake timers must be active BEFORE StartAsync so the 30s check loop is driven by the test clock.
    jest.useFakeTimers();
    jest.setSystemTime(BaseTime);
    try {
      await CleanupAsync(Workspace);
      await fs.writeFile(RemindersFilePath(Workspace), JSON.stringify(Seed, null, 2), 'utf8');
      await Reminders.StartAsync(EmptyWorkspaceStats);

      // One natural (non-forced) 30s cycle on the snooze day drives the snooze-day gate:
      // overdue -> snoozed (emits ReminderSnoozed) -> advanced -> scheduled.
      await jest.advanceTimersByTimeAsync(30000);

      // Restore real timers BEFORE polling: ReadLedgerUntilAsync relies on Date.now()/setTimeout,
      // which are frozen under fake timers. The fire-and-forget append itself is real fs I/O.
      jest.useRealTimers();

      const Ledger = await ReadLedgerForTypeAsync(Workspace, ReminderID, 'ReminderSnoozed');
      const Snoozed = Ledger.find(ArgEvent => ArgEvent.type === 'ReminderSnoozed' && ArgEvent.reminderId === ReminderID);
      expect(Snoozed).toBeDefined();
      expect(Snoozed.workspace).toBe(Workspace);
      expect(Snoozed.v).toBe(CURRENT_SCHEMA_VERSION);
      expect(typeof Snoozed.id).toBe('string');
      expect(typeof Snoozed.ts).toBe('string');
      expect(Snoozed.payload.by).toBe('U_ASSIGNEE');
      expect(typeof Snoozed.payload.until).toBe('string');
    } finally {
      jest.useRealTimers();
      await Reminders.StopAsync();
      await CleanupAsync(Workspace);
    }
  });
});
