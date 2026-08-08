'use strict';

const fs = require('fs').promises;
const path = require('path');
const WebAPI = require('../src/web-api');
const workspaces = require('../src/workspaces');
const AdminAuth = require('../src/admin-auth');

const TestBearerToken = 'test-bearer-token';
const TestPort = 19876; // fixed test port to avoid conflicts with dev server (2020).

/**
 * Create a minimal WebAPI instance for testing.
 * @param {Map<string, any>} [ArgSlackAppsByWorkspace] Optional workspace → mock SlackApp map.
 * @returns {WebAPI}
 */
function CreateTestWebAPI(ArgSlackAppsByWorkspace) {
  const StatsMap = new Map();
  const MockSettingsModule = { GetLastManualFilePath: () => null, SetLastManualFilePathAsync: async () => {} };
  const MockAdminAuth = new AdminAuth();
  const MockAdminMailer = { SendPasswordResetEmailAsync: async () => {} };
  return new WebAPI(TestPort, TestBearerToken, StatsMap, MockSettingsModule, MockAdminAuth, MockAdminMailer, ArgSlackAppsByWorkspace);
}

/**
 * Helper to make authenticated GET requests against the test server.
 * @param {number} ArgPort Port number.
 * @param {string} ArgPath Request path.
 * @returns {Promise<{success: boolean, data: any}>}
 */
async function AuthenticatedGetAsync(ArgPort, ArgPath) {
  const Response = await fetch(`http://127.0.0.1:${ArgPort}${ArgPath}`, {
    headers: { 'Authorization': `Bearer ${TestBearerToken}` },
  });
  return Response.json();
}

describe('GET /workspace/:name/reminders', () => {
  /** @type {WebAPI} */
  let API;
  let ActualPort;
  const RemindersDir = path.join(__dirname, '..', 'data', 'runtime', 'reminders');
  const EventsDir = path.join(__dirname, '..', 'data', 'runtime', 'events');
  const TestWorkspaceName = 'WebAPIRemindersTest';
  const RemindersFilePath = path.join(RemindersDir, `${TestWorkspaceName}_reminders.json`);
  const EventsFilePath = path.join(EventsDir, `${TestWorkspaceName}_events.jsonl`);
  // mutable map held by the WebAPI instance — tests that need a live mock SlackApp set it here.
  const TestSlackApps = new Map();

  beforeAll(async () => {
    API = CreateTestWebAPI(TestSlackApps);
    await API.StartAsync();
    ActualPort = TestPort;
  });

  afterAll(async () => {
    await API.StopAsync();
    await fs.rm(RemindersFilePath, { force: true });
    await fs.rm(EventsFilePath, { force: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    TestSlackApps.clear();
    delete process.env.REMINDERS_READ_SOURCE;
    delete process.env.REBALANCE_EXPORT_SOURCE;
    delete process.env.COMPLETED_READ_SOURCE;
  });

  test('reminder and rebalance flags independently use a lossless event projection and roll back to JSON', async () => {
    const ReminderSeed = [{
      ReminderID: 'api-projection-1', CreatedOn: '2026-08-01T12:00:00.000Z', ShouldPostOn: '2026-08-02T12:00:00.000Z',
      TargetChannelID: 'C_REMINDERS', OriginalChannelID: 'C_SOURCE', OriginalMessageID: '100.200',
      OriginalThreadTs: '100.000', OriginalSenderID: 'U_SENDER', OriginalChannelName: 'engineering',
      ReminderMessageText: 'Use the projection', IgnoreSnooze: false, AssigneeID: 'U_OWNER', AssigneeIDs: ['U_OWNER'],
      GitHubUrls: [], clientId: null, projectId: null, State: 'scheduled',
    }];
    const Event = {
      v: 1, id: 'baseline-api-projection-1', ts: ReminderSeed[0].CreatedOn, workspace: TestWorkspaceName,
      type: 'BaselineReminderImported', reminderId: ReminderSeed[0].ReminderID,
      payload: {
        text: ReminderSeed[0].ReminderMessageText, assigneeId: 'U_OWNER', assigneeIds: ['U_OWNER'],
        sourceChannelId: 'C_SOURCE', targetChannelId: 'C_REMINDERS', dueAt: ReminderSeed[0].ShouldPostOn,
        state: 'scheduled', githubUrls: [], createdOn: ReminderSeed[0].CreatedOn,
        originalSenderId: 'U_SENDER', originalMessageId: '100.200', originalThreadTs: '100.000',
        originalChannelName: 'engineering', ignoreSnooze: false, clientId: null, projectId: null,
      },
    };
    jest.spyOn(workspaces, 'WorkspaceExistsAsync').mockResolvedValue(true);
    await fs.mkdir(RemindersDir, { recursive: true });
    await fs.mkdir(EventsDir, { recursive: true });
    await fs.writeFile(RemindersFilePath, JSON.stringify(ReminderSeed), 'utf8');
    await fs.writeFile(EventsFilePath, `${JSON.stringify(Event)}\n`, 'utf8');

    process.env.REMINDERS_READ_SOURCE = 'projection';
    const ProjectedRaw = await AuthenticatedGetAsync(ActualPort, `/workspace/${TestWorkspaceName}/reminders`);
    expect(ProjectedRaw).toEqual({ success: true, data: ReminderSeed });
    delete process.env.REMINDERS_READ_SOURCE;
    const RolledBackRaw = await AuthenticatedGetAsync(ActualPort, `/workspace/${TestWorkspaceName}/reminders`);
    expect(RolledBackRaw).toEqual({ success: true, data: ReminderSeed });

    process.env.REBALANCE_EXPORT_SOURCE = 'projection';
    const ProjectedRebalance = await AuthenticatedGetAsync(ActualPort, `/workspace/${TestWorkspaceName}/reminders?format=rebalance`);
    delete process.env.REBALANCE_EXPORT_SOURCE;
    const RolledBackRebalance = await AuthenticatedGetAsync(ActualPort, `/workspace/${TestWorkspaceName}/reminders?format=rebalance`);
    expect(ProjectedRebalance.success).toBe(true);
    expect(RolledBackRebalance.success).toBe(true);
    expect(ProjectedRebalance.data.reminders).toEqual(RolledBackRebalance.data.reminders);
    expect(ProjectedRebalance.data.source).toEqual(RolledBackRebalance.data.source);
  });

  test('returns reminders array from disk for a valid workspace', async () => {
    const ReminderSeed = [
      {
        ReminderID: 'api-test-0001',
        CreatedOn: '2026-03-20T09:00:00.000Z',
        ShouldPostOn: '2026-03-28T09:00:00.000Z',
        TargetChannelID: 'C_REMINDERS',
        OriginalChannelID: 'C_GENERAL',
        OriginalMessageID: '1773990000.500001',
        OriginalSenderID: 'U_SENDER',
        ReminderMessageText: 'Review PR 240',
        IgnoreSnooze: false,
        State: 'scheduled',
      },
      {
        ReminderID: 'api-test-0002',
        CreatedOn: '2026-03-21T09:00:00.000Z',
        ShouldPostOn: '2026-03-29T09:00:00.000Z',
        TargetChannelID: 'C_REMINDERS',
        OriginalChannelID: 'C_GENERAL',
        OriginalMessageID: '1773990000.500002',
        OriginalSenderID: 'U_SENDER',
        ReminderMessageText: 'Ship hotfix',
        IgnoreSnooze: false,
        State: 'scheduled',
      },
    ];

    jest.spyOn(workspaces, 'WorkspaceExistsAsync').mockResolvedValue(true);
    await fs.mkdir(RemindersDir, { recursive: true });
    await fs.writeFile(RemindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');

    const Result = await AuthenticatedGetAsync(ActualPort, `/workspace/${TestWorkspaceName}/reminders`);

    expect(Result.success).toBe(true);
    expect(Result.data).toHaveLength(2);
    expect(Result.data[0].ReminderID).toBe('api-test-0001');
    expect(Result.data[0].ReminderMessageText).toBe('Review PR 240');
    expect(Result.data[1].ReminderID).toBe('api-test-0002');
  });

  test('returns rebalance-friendly reminder export for external consumers', async () => {
    const ReminderSeed = [
      {
        ReminderID: 'api-test-1001',
        CreatedOn: '2026-03-20T09:00:00.000Z',
        ShouldPostOn: '2026-03-28T09:00:00.000Z',
        TargetChannelID: 'C_REMINDERS',
        OriginalChannelID: 'C_GENERAL',
        OriginalChannelName: 'general',
        OriginalMessageID: '1773990000.900001',
        OriginalThreadTs: '1773990000.800001',
        OriginalSenderID: 'U_SENDER',
        AssigneeID: 'U_ASSIGNEE',
        ReminderMessageText: 'Review PR 240',
        IgnoreSnooze: false,
        GitHubUrls: ['https://github.com/NeochromeTeam/sleuth-app/pull/240'],
        State: 'scheduled',
      }
    ];

    jest.spyOn(workspaces, 'WorkspaceExistsAsync').mockResolvedValue(true);
    await fs.mkdir(RemindersDir, { recursive: true });
    await fs.writeFile(RemindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');

    const Result = await AuthenticatedGetAsync(
      ActualPort,
      `/workspace/${TestWorkspaceName}/reminders?format=rebalance`
    );

    expect(Result.success).toBe(true);
    expect(Result.data.workspaceName).toBe(TestWorkspaceName);
    expect(Result.data.totalReminderCount).toBe(1);
    expect(Result.data.returnedReminderCount).toBe(1);
    expect(Result.data.source.relativePath).toBe(`data/runtime/reminders/${TestWorkspaceName}_reminders.json`);
    expect(Array.isArray(Result.data.reminders)).toBe(true);
    expect(Result.data.reminders[0]).toMatchObject({
      reminderId: 'api-test-1001',
      state: 'scheduled',
      isActive: true,
      createdOn: '2026-03-20T09:00:00.000Z',
      shouldPostOn: '2026-03-28T09:00:00.000Z',
      reminderMessageText: 'Review PR 240',
      ignoreSnooze: false,
      assigneeId: 'U_ASSIGNEE',
      originalSenderId: 'U_SENDER',
      targetChannelId: 'C_REMINDERS',
      originalChannelId: 'C_GENERAL',
      originalChannelName: 'general',
      originalMessageId: '1773990000.900001',
      originalThreadTs: '1773990000.800001',
      githubUrls: ['https://github.com/NeochromeTeam/sleuth-app/pull/240'],
    });
    // GH-367 P2: clientId surfaced on the record, resolved from the client mapping. This seed's PR is
    // on NeochromeTeam/sleuth-app, which maps to the `sleuth` client (GitHubRepoPatterns: ["sleuth-app"]).
    expect(Result.data.reminders[0]).toHaveProperty('clientId', 'sleuth');

    // pre-rendered display block: show-reminders wording/sectioning baked into the export.
    const Display = Result.data.reminders[0].display;
    expect(Display.label).toBe('A');
    expect(Display.sectionKey).toBe('dueOlder'); // 2026-03 due date is long past
    expect(Display.sectionLabel).toBe('🔴 Due older than 7 days');
    expect(Display.summary).toBe('Review PR 240');
    expect(Display.slackSummary).toBe('Review PR 240');
    // no live SlackApp in this test → deterministic constructed archive URL.
    expect(Display.permalink).toBe(`https://${TestWorkspaceName}.slack.com/archives/C_GENERAL/p1773990000900001`);
    expect(Display.taggedUserId).toBe('U_ASSIGNEE');
    expect(Display.assigneeName).toBeNull();
    expect(typeof Display.ageDays).toBe('number');

    // top-level display metadata for consumers rendering the sections.
    expect(Result.data.display.timeZone).toBe('UTC');
    expect(Result.data.display.sectionOrder).toHaveLength(4);
    expect(Result.data.display.sectionOrder[0]).toEqual({ key: 'dueToday', label: '📅 Due Today' });

    expect(typeof Result.data.fetchedAt).toBe('string');
  });

  test('orders rebalance reminders by due-date section then chronologically, with global labels', async () => {
    const NoonUtcOffsetDays = (ArgDays) => {
      const Day = new Date(Date.now() + ArgDays * 24 * 60 * 60 * 1000);
      Day.setUTCHours(12, 0, 0, 0);
      return Day.toISOString();
    };
    const MakeSeed = (ArgId, ArgShouldPostOn) => ({
      ReminderID: ArgId,
      CreatedOn: NoonUtcOffsetDays(-40),
      ShouldPostOn: ArgShouldPostOn,
      TargetChannelID: 'C_REMINDERS',
      OriginalChannelID: 'C_GENERAL',
      OriginalMessageID: '1773990000.600001',
      OriginalSenderID: 'U_SENDER',
      ReminderMessageText: `Task ${ArgId}`,
      IgnoreSnooze: false,
      State: 'scheduled',
    });
    // seeded deliberately out of order: older-than-7d, upcoming, today, last-7-days.
    const ReminderSeed = [
      MakeSeed('older', NoonUtcOffsetDays(-30)),
      MakeSeed('upcoming', NoonUtcOffsetDays(3)),
      MakeSeed('today', NoonUtcOffsetDays(0)),
      MakeSeed('lastweek', NoonUtcOffsetDays(-2)),
    ];

    jest.spyOn(workspaces, 'WorkspaceExistsAsync').mockResolvedValue(true);
    await fs.mkdir(RemindersDir, { recursive: true });
    await fs.writeFile(RemindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');

    const Result = await AuthenticatedGetAsync(
      ActualPort,
      `/workspace/${TestWorkspaceName}/reminders?format=rebalance`
    );

    expect(Result.success).toBe(true);
    // section order: Due Today, Due after today, Due within last 7 days, Due older than 7 days.
    expect(Result.data.reminders.map(ArgReminder => ArgReminder.reminderId))
      .toEqual(['today', 'upcoming', 'lastweek', 'older']);
    expect(Result.data.reminders.map(ArgReminder => ArgReminder.display.label))
      .toEqual(['A', 'B', 'C', 'D']);
    expect(Result.data.reminders.map(ArgReminder => ArgReminder.display.sectionKey))
      .toEqual(['dueToday', 'dueUpcoming', 'dueLastWeek', 'dueOlder']);
  });

  test('resolves display names and real permalinks through the workspace SlackApp when available', async () => {
    const ReminderSeed = [{
      ReminderID: 'api-test-3001',
      CreatedOn: '2026-03-20T09:00:00.000Z',
      ShouldPostOn: '2026-03-28T09:00:00.000Z',
      TargetChannelID: 'C_REMINDERS',
      OriginalChannelID: 'C_GENERAL',
      OriginalMessageID: '1773990000.300001',
      OriginalSenderID: 'U_SENDER',
      AssigneeID: 'U_ASSIGNEE',
      ReminderMessageText: 'Ping <@U_OTHER> about the export',
      IgnoreSnooze: false,
      State: 'scheduled',
    }];

    TestSlackApps.set(TestWorkspaceName, {
      GetUserDisplayNameAsync: async (ArgUserId) =>
        ({ U_ASSIGNEE: 'Alex Rivera', U_OTHER: 'Mike' })[ArgUserId] || null,
      GetPermaLinkAsync: async () => 'https://neochrome.slack.com/archives/C_GENERAL/p1773990000300001?thread_ts=123',
    });

    jest.spyOn(workspaces, 'WorkspaceExistsAsync').mockResolvedValue(true);
    await fs.mkdir(RemindersDir, { recursive: true });
    await fs.writeFile(RemindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');

    const Result = await AuthenticatedGetAsync(
      ActualPort,
      `/workspace/${TestWorkspaceName}/reminders?format=rebalance`
    );

    expect(Result.success).toBe(true);
    const Display = Result.data.reminders[0].display;
    expect(Display.assigneeName).toBe('Alex Rivera');
    expect(Display.permalink).toBe('https://neochrome.slack.com/archives/C_GENERAL/p1773990000300001?thread_ts=123');
    // web-safe summary: mention token resolved to a readable name; Slack variant keeps the token.
    expect(Display.summary).toBe('Ping @Mike about the export');
    expect(Display.slackSummary).toBe('Ping <@U_OTHER> about the export');
  });

  test('filters reminders for rebalance export using activeOnly and state query parameters', async () => {
    const ReminderSeed = [
      {
        ReminderID: 'api-test-2001',
        CreatedOn: '2026-03-20T09:00:00.000Z',
        ShouldPostOn: '2026-03-28T09:00:00.000Z',
        TargetChannelID: 'C_REMINDERS',
        OriginalChannelID: 'C_GENERAL',
        OriginalMessageID: '1773990000.700001',
        OriginalSenderID: 'U_SENDER',
        ReminderMessageText: 'Still pending',
        IgnoreSnooze: false,
        State: 'scheduled',
      },
      {
        ReminderID: 'api-test-2002',
        CreatedOn: '2026-03-21T09:00:00.000Z',
        ShouldPostOn: '2026-03-29T09:00:00.000Z',
        TargetChannelID: 'C_REMINDERS',
        OriginalChannelID: 'C_GENERAL',
        OriginalMessageID: '1773990000.700002',
        OriginalSenderID: 'U_SENDER',
        ReminderMessageText: 'Dead letter',
        IgnoreSnooze: false,
        State: 'dead-letter',
      },
      {
        ReminderID: 'api-test-2003',
        CreatedOn: '2026-03-22T09:00:00.000Z',
        ShouldPostOn: '2026-03-30T09:00:00.000Z',
        TargetChannelID: 'C_REMINDERS',
        OriginalChannelID: 'C_GENERAL',
        OriginalMessageID: '1773990000.700003',
        OriginalSenderID: 'U_SENDER',
        ReminderMessageText: 'Legacy no-state reminder',
        IgnoreSnooze: false,
      },
    ];

    jest.spyOn(workspaces, 'WorkspaceExistsAsync').mockResolvedValue(true);
    await fs.mkdir(RemindersDir, { recursive: true });
    await fs.writeFile(RemindersFilePath, JSON.stringify(ReminderSeed, null, 2), 'utf8');

    const ActiveOnlyResult = await AuthenticatedGetAsync(
      ActualPort,
      `/workspace/${TestWorkspaceName}/reminders?format=rebalance&activeOnly=true`
    );
    expect(ActiveOnlyResult.success).toBe(true);
    expect(ActiveOnlyResult.data.totalReminderCount).toBe(3);
    expect(ActiveOnlyResult.data.returnedReminderCount).toBe(2);
    expect(ActiveOnlyResult.data.reminders.map(ArgReminder => ArgReminder.reminderId)).toEqual([
      'api-test-2001',
      'api-test-2003',
    ]);
    expect(ActiveOnlyResult.data.reminders[1].state).toBe('scheduled');

    const StateFilterResult = await AuthenticatedGetAsync(
      ActualPort,
      `/workspace/${TestWorkspaceName}/reminders?format=rebalance&state=dead-letter`
    );
    expect(StateFilterResult.success).toBe(true);
    expect(StateFilterResult.data.returnedReminderCount).toBe(1);
    expect(StateFilterResult.data.reminders[0].reminderId).toBe('api-test-2002');
  });

  test('returns empty array when workspace has no reminders file', async () => {
    jest.spyOn(workspaces, 'WorkspaceExistsAsync').mockResolvedValue(true);
    // ensure no file exists.
    await fs.rm(RemindersFilePath, { force: true });

    const Result = await AuthenticatedGetAsync(ActualPort, `/workspace/${TestWorkspaceName}/reminders`);

    expect(Result.success).toBe(true);
    expect(Result.data).toEqual([]);
  });

  test('returns error when workspace does not exist', async () => {
    jest.spyOn(workspaces, 'WorkspaceExistsAsync').mockResolvedValue(false);

    const Result = await AuthenticatedGetAsync(ActualPort, '/workspace/NonExistentWorkspace/reminders');

    expect(Result.success).toBe(false);
    expect(Result.data).toContain('Workspace not found');
  });

  test('rejects unauthenticated requests', async () => {
    const Response = await fetch(`http://127.0.0.1:${ActualPort}/workspace/${TestWorkspaceName}/reminders`);
    const Result = await Response.json();

    expect(Result.success).toBe(false);
    expect(Result.data).toBe('Forbidden.');
  });

  test('returns an error for invalid reminders query values', async () => {
    jest.spyOn(workspaces, 'WorkspaceExistsAsync').mockResolvedValue(true);

    const Result = await AuthenticatedGetAsync(
      ActualPort,
      `/workspace/${TestWorkspaceName}/reminders?format=rebalance&activeOnly=maybe`
    );

    expect(Result.success).toBe(false);
    expect(Result.data).toContain('activeOnly');
  });
});
