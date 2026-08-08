'use strict';

const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const {
  BuildBaselineEvent,
  ImportWorkspaceAsync,
  MainAsync,
} = require('../scripts/baseline-import.js');
const { FoldReminderReadModels } = require('../src/reminders-projection');

/**
 * @returns {Promise<{ RepoRoot: string, RemindersDir: string, EventsDir: string }>}
 */
async function MakeFixtureRepoAsync() {
  const RepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-import-'));
  const RemindersDir = path.join(RepoRoot, 'data', 'runtime', 'reminders');
  const EventsDir = path.join(RepoRoot, 'data', 'runtime', 'events');
  await fs.mkdir(RemindersDir, { recursive: true });
  await fs.mkdir(EventsDir, { recursive: true });
  return { RepoRoot, RemindersDir, EventsDir };
}

/**
 * @param {string} ArgFilePath
 * @param {any[]} ArgPayload
 * @returns {Promise<void>}
 */
async function WriteJsonAsync(ArgFilePath, ArgPayload) {
  await fs.writeFile(ArgFilePath, JSON.stringify(ArgPayload, null, 2), 'utf8');
}

/**
 * @param {string} ArgFilePath
 * @param {object[]} ArgEvents
 * @returns {Promise<void>}
 */
async function WriteJsonlAsync(ArgFilePath, ArgEvents) {
  const Raw = ArgEvents.map(ArgEvent => JSON.stringify(ArgEvent)).join('\n');
  await fs.writeFile(ArgFilePath, Raw.length > 0 ? `${Raw}\n` : '', 'utf8');
}

/**
 * @param {string} ArgFilePath
 * @returns {Promise<any[]>}
 */
async function ReadJsonlAsync(ArgFilePath) {
  const Raw = await fs.readFile(ArgFilePath, 'utf8');
  return Raw.split('\n').filter(Boolean).map(ArgLine => JSON.parse(ArgLine));
}

describe('baseline-import', () => {
  let RepoRoot;
  let RemindersDir;
  let EventsDir;

  beforeEach(async () => {
    ({ RepoRoot, RemindersDir, EventsDir } = await MakeFixtureRepoAsync());
  });

  afterEach(async () => {
    await fs.rm(RepoRoot, { recursive: true, force: true });
  });

  test('imports missing baseline events from both stores and preserves payload fields', async () => {
    const Workspace = 'alpha';
    await WriteJsonAsync(path.join(RemindersDir, `${Workspace}_reminders.json`), [
      {
        ReminderID: 'rem_active_missing',
        CreatedOn: '2026-06-01T10:00:00.000Z',
        ShouldPostOn: '2026-06-05T15:00:00.000Z',
        TargetChannelID: 'C_REM',
        OriginalChannelID: 'C_SRC',
        OriginalChannelName: 'general',
        OriginalMessageID: '1773990000.100001',
        OriginalSenderID: 'U_SENDER',
        OriginalThreadTs: '1773990000.100001',
        ReminderMessageText: 'ship the hotfix',
        IgnoreSnooze: true,
        AssigneeID: 'U_ASSIGNEE',
        GitHubUrls: ['https://github.com/acme/repo/pull/1'],
        State: 'scheduled',
      },
      {
        ReminderID: 'rem_active_seeded',
        CreatedOn: '2026-06-02T10:00:00.000Z',
        ShouldPostOn: '2026-06-06T15:00:00.000Z',
        TargetChannelID: 'C_REM',
        OriginalChannelID: 'C_SRC_2',
        ReminderMessageText: 'already seeded',
        State: 'scheduled',
      },
    ]);

    await WriteJsonAsync(path.join(RemindersDir, `${Workspace}_completed.json`), [
      {
        ReminderID: 'rem_completed_missing',
        CreatedOn: '2026-05-25T08:00:00.000Z',
        ShouldPostOn: '2026-05-30T14:00:00.000Z',
        TargetChannelID: 'C_DONE',
        OriginalChannelID: 'C_DONE_SRC',
        OriginalChannelName: 'ops',
        OriginalMessageID: '1773990000.200001',
        OriginalSenderID: 'U_DONE_SENDER',
        OriginalThreadTs: '1773990000.200001',
        ReminderMessageText: 'close the incident',
        IgnoreSnooze: false,
        AssigneeID: 'U_DONE',
        GitHubUrls: ['https://github.com/acme/repo/issues/9'],
        State: 'completed',
      },
      {
        reminderId: 'rem_completed_seeded',
        summary: 'already baseline imported',
        assigneeID: 'U_OLD',
        sourceChannelID: 'C_OLD',
        dueDate: '2026-05-20T09:00:00.000Z',
        completedMs: Date.parse('2026-05-21T09:00:00.000Z'),
      },
    ]);

    await WriteJsonlAsync(path.join(EventsDir, `${Workspace}_events.jsonl`), [
      {
        v: 1,
        id: 'evt_created_existing',
        ts: '2026-06-02T10:00:00.000Z',
        workspace: Workspace,
        type: 'ReminderCreated',
        reminderId: 'rem_active_seeded',
        payload: {
          text: 'already seeded',
          assigneeId: null,
          sourceChannelId: 'C_SRC_2',
          targetChannelId: 'C_REM',
          source: 'fsm',
          githubUrls: [],
        },
      },
      {
        v: 1,
        id: 'evt_baseline_existing',
        ts: '2026-05-20T08:00:00.000Z',
        workspace: Workspace,
        type: 'BaselineReminderImported',
        reminderId: 'rem_completed_seeded',
        payload: {
          text: 'already baseline imported',
          assigneeId: 'U_OLD',
          sourceChannelId: 'C_OLD',
          targetChannelId: 'C_OLD',
          dueAt: '2026-05-20T09:00:00.000Z',
          state: 'completed',
          githubUrls: [],
        },
      },
    ]);

    const Result = await ImportWorkspaceAsync({
      workspace: Workspace,
      remindersDir: RemindersDir,
      eventsDir: EventsDir,
      write: true,
    });

    expect(Result.appendedCount).toBe(2);
    expect(Result.baselineEvents).toHaveLength(2);

    const Persisted = await ReadJsonlAsync(path.join(EventsDir, `${Workspace}_events.jsonl`));
    const Imported = Persisted.filter(ArgEvent => ArgEvent.type === 'BaselineReminderImported' && (
      ArgEvent.reminderId === 'rem_active_missing' || ArgEvent.reminderId === 'rem_completed_missing'
    ));
    expect(Imported).toHaveLength(2);

    const ById = Object.fromEntries(Imported.map(ArgEvent => [ArgEvent.reminderId, ArgEvent]));
    expect(ById.rem_active_missing.ts).toBe('2026-06-01T10:00:00.000Z');
    expect(ById.rem_active_missing.payload).toEqual({
      text: 'ship the hotfix',
      assigneeId: 'U_ASSIGNEE',
      sourceChannelId: 'C_SRC',
      targetChannelId: 'C_REM',
      dueAt: '2026-06-05T15:00:00.000Z',
      state: 'scheduled',
      githubUrls: ['https://github.com/acme/repo/pull/1'],
      originalSenderId: 'U_SENDER',
      originalMessageId: '1773990000.100001',
      originalThreadTs: '1773990000.100001',
      originalChannelName: 'general',
      ignoreSnooze: true,
      // Schema v2. assigneeIds is derived from the deprecated scalar when a legacy record predates
      // shared assignments, so the import cannot silently undo GH-22.
      assigneeIds: ['U_ASSIGNEE'],
      clientId: null,
      gitHubRelayStarted: false,
      gitHubRelayStopped: false,
      createdOn: '2026-06-01T10:00:00.000Z',
    });

    expect(ById.rem_completed_missing.ts).toBe('2026-05-25T08:00:00.000Z');
    expect(ById.rem_completed_missing.payload).toEqual({
      text: 'close the incident',
      assigneeId: 'U_DONE',
      sourceChannelId: 'C_DONE_SRC',
      targetChannelId: 'C_DONE',
      dueAt: '2026-05-30T14:00:00.000Z',
      state: 'completed',
      githubUrls: ['https://github.com/acme/repo/issues/9'],
      originalSenderId: 'U_DONE_SENDER',
      originalMessageId: '1773990000.200001',
      originalThreadTs: '1773990000.200001',
      originalChannelName: 'ops',
      ignoreSnooze: false,
      assigneeIds: ['U_DONE'],
      clientId: null,
      gitHubRelayStarted: false,
      gitHubRelayStopped: false,
      createdOn: '2026-05-25T08:00:00.000Z',
    });
  });

  test('re-running is idempotent and does not duplicate baseline imports', async () => {
    const Workspace = 'beta';
    await WriteJsonAsync(path.join(RemindersDir, `${Workspace}_reminders.json`), [{
      ReminderID: 'rem_once',
      CreatedOn: '2026-06-10T09:00:00.000Z',
      ShouldPostOn: '2026-06-11T09:00:00.000Z',
      TargetChannelID: 'C_ONE',
      OriginalChannelID: 'C_SRC_ONE',
      ReminderMessageText: 'one task',
      State: 'scheduled',
    }]);
    await WriteJsonAsync(path.join(RemindersDir, `${Workspace}_completed.json`), []);

    const First = await ImportWorkspaceAsync({
      workspace: Workspace,
      remindersDir: RemindersDir,
      eventsDir: EventsDir,
      write: true,
    });
    const Second = await ImportWorkspaceAsync({
      workspace: Workspace,
      remindersDir: RemindersDir,
      eventsDir: EventsDir,
      write: true,
    });

    expect(First.appendedCount).toBe(1);
    expect(Second.appendedCount).toBe(0);

    const Persisted = await ReadJsonlAsync(path.join(EventsDir, `${Workspace}_events.jsonl`));
    expect(Persisted.filter(ArgEvent => ArgEvent.type === 'BaselineReminderImported')).toHaveLength(1);
  });

  test('handles thin completed-store rows and uses deterministic fallback timestamps', async () => {
    const Event = BuildBaselineEvent({
      reminderId: 'rem_thin_completed',
      summary: 'thin completion row',
      assigneeID: 'U_THIN',
      sourceChannelID: 'C_THIN',
      dueDate: '2026-06-03T12:00:00.000Z',
      completedMs: Date.parse('2026-06-04T12:00:00.000Z'),
    }, 'completed');

    expect(Event).toEqual({
      v: 2,
      type: 'BaselineReminderImported',
      reminderId: 'rem_thin_completed',
      ts: '2026-06-03T12:00:00.000Z',
      payload: {
        text: 'thin completion row',
        assigneeId: 'U_THIN',
        sourceChannelId: 'C_THIN',
        targetChannelId: 'C_THIN',
        dueAt: '2026-06-03T12:00:00.000Z',
        state: 'completed',
        githubUrls: [],
        originalSenderId: null,
        originalMessageId: null,
        originalThreadTs: null,
        originalChannelName: null,
        ignoreSnooze: false,
        assigneeIds: ['U_THIN'],
        clientId: null,
        gitHubRelayStarted: false,
        gitHubRelayStopped: false,
        createdOn: '2026-06-03T12:00:00.000Z',
      },
    });
  });

  test('main can discover workspaces under a repo root and append only for requested workspace', async () => {
    await WriteJsonAsync(path.join(RemindersDir, 'gamma_reminders.json'), [{
      ReminderID: 'rem_gamma',
      CreatedOn: '2026-06-12T09:00:00.000Z',
      ShouldPostOn: '2026-06-13T09:00:00.000Z',
      TargetChannelID: 'C_GAMMA',
      ReminderMessageText: 'gamma task',
    }]);
    await WriteJsonAsync(path.join(RemindersDir, 'delta_reminders.json'), [{
      ReminderID: 'rem_delta',
      CreatedOn: '2026-06-14T09:00:00.000Z',
      ShouldPostOn: '2026-06-15T09:00:00.000Z',
      TargetChannelID: 'C_DELTA',
      ReminderMessageText: 'delta task',
    }]);

    const Results = await MainAsync(['--repo-root', RepoRoot, '--workspace', 'gamma', '--write']);

    expect(Results).toHaveLength(1);
    expect(Results[0].workspace).toBe('gamma');

    const GammaEvents = await ReadJsonlAsync(path.join(EventsDir, 'gamma_events.jsonl'));
    expect(GammaEvents).toHaveLength(1);
    await expect(fs.readFile(path.join(EventsDir, 'delta_events.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // --- schema v2 backfill (--enrich) ---

  /** The v1-shaped event this importer used to write: no createdOn, assigneeIds, or relay flags. */
  function LegacyBaselineEvent(ArgReminderId) {
    return {
      v: 1,
      id: 'evt_legacy',
      ts: '2026-06-20T09:00:00.000Z',
      workspace: 'gamma',
      type: 'BaselineReminderImported',
      reminderId: ArgReminderId,
      payload: {
        text: 'legacy import', assigneeId: 'U_LEGACY', sourceChannelId: 'C_SRC',
        targetChannelId: 'C_REM', dueAt: '2026-06-25T09:00:00.000Z', state: 'scheduled',
        githubUrls: ['https://github.com/acme/repo/pull/3'],
      },
    };
  }

  /** The live JSON record that legacy event was derived from. */
  function LegacyJsonReminder() {
    return {
      ReminderID: 'rem_legacy',
      CreatedOn: '2026-06-20T09:00:00.000Z',
      ShouldPostOn: '2026-06-25T09:00:00.000Z',
      TargetChannelID: 'C_REM',
      OriginalChannelID: 'C_SRC',
      OriginalMessageID: '1773990000.300001',
      OriginalThreadTs: '1773990000.300001',
      OriginalSenderID: 'U_SENDER',
      OriginalChannelName: 'general',
      ReminderMessageText: 'legacy import',
      AssigneeID: 'U_LEGACY',
      AssigneeIDs: ['U_LEGACY', 'U_SECOND'],
      GitHubUrls: ['https://github.com/acme/repo/pull/3'],
      GitHubRelayStopped: true,
      IgnoreSnooze: false,
      State: 'scheduled',
    };
  }

  async function SeedLegacyWorkspaceAsync() {
    await WriteJsonAsync(path.join(RemindersDir, 'gamma_reminders.json'), [LegacyJsonReminder()]);
    await WriteJsonAsync(path.join(RemindersDir, 'gamma_completed.json'), []);
    await WriteJsonlAsync(path.join(EventsDir, 'gamma_events.jsonl'), [LegacyBaselineEvent('rem_legacy')]);
  }

  test('without --enrich a seeded reminder is skipped even when its event predates v2', async () => {
    await SeedLegacyWorkspaceAsync();
    const Result = await ImportWorkspaceAsync({
      workspace: 'gamma', remindersDir: RemindersDir, eventsDir: EventsDir, write: true,
    });
    expect(Result.appendedCount).toBe(0);
    expect(Result.skippedReminderIds).toEqual(['rem_legacy']);
    expect(Result.enrichedReminderIds).toEqual([]);
  });

  test('--enrich re-emits a v2 event for a reminder whose stream predates the schema expansion', async () => {
    // The structural gap: seeding-only could never repair a stream, because every reminder that
    // needs repair is by definition already seeded.
    await SeedLegacyWorkspaceAsync();
    const Result = await ImportWorkspaceAsync({
      workspace: 'gamma', remindersDir: RemindersDir, eventsDir: EventsDir, write: true, enrich: true,
    });

    expect(Result.appendedCount).toBe(1);
    expect(Result.enrichedReminderIds).toEqual(['rem_legacy']);

    const Persisted = await ReadJsonlAsync(path.join(EventsDir, 'gamma_events.jsonl'));
    expect(Persisted).toHaveLength(2);
    const Enriched = Persisted[1];
    expect(Enriched.v).toBe(2);
    expect(Enriched.payload.createdOn).toBe('2026-06-20T09:00:00.000Z');
    expect(Enriched.payload.assigneeIds).toEqual(['U_LEGACY', 'U_SECOND']);
    expect(Enriched.payload.gitHubRelayStopped).toBe(true);
  });

  test('--enrich is idempotent: a stream already complete is not re-emitted', async () => {
    await SeedLegacyWorkspaceAsync();
    const First = await ImportWorkspaceAsync({
      workspace: 'gamma', remindersDir: RemindersDir, eventsDir: EventsDir, write: true, enrich: true,
    });
    const Second = await ImportWorkspaceAsync({
      workspace: 'gamma', remindersDir: RemindersDir, eventsDir: EventsDir, write: true, enrich: true,
    });

    expect(First.appendedCount).toBe(1);
    expect(Second.appendedCount).toBe(0);
    expect(Second.skippedReminderIds).toEqual(['rem_legacy']);
  });

  test('an enriched stream folds losslessly where the legacy one is rejected', async () => {
    // The whole point of the backfill: the same reminder goes from unprojectable to projectable
    // without the JSON store changing at all.
    await SeedLegacyWorkspaceAsync();

    const Legacy = await ReadJsonlAsync(path.join(EventsDir, 'gamma_events.jsonl'));
    expect(() => FoldReminderReadModels(Legacy, { strict: true })).toThrow(/GitHubRelayStopped/);

    await ImportWorkspaceAsync({
      workspace: 'gamma', remindersDir: RemindersDir, eventsDir: EventsDir, write: true, enrich: true,
    });

    const Repaired = await ReadJsonlAsync(path.join(EventsDir, 'gamma_events.jsonl'));
    const Folded = FoldReminderReadModels(Repaired, { strict: true });
    expect(Folded.reminders).toHaveLength(1);
    // Enrichment FILLS: the identity the v1 event established survives, the gaps get closed.
    expect(Folded.reminders[0].ReminderID).toBe('rem_legacy');
    expect(Folded.reminders[0].GitHubRelayStopped).toBe(true);
    expect(Folded.reminders[0].AssigneeIDs).toEqual(['U_LEGACY', 'U_SECOND']);
    expect(Folded.reminders[0].CreatedOn).toBe('2026-06-20T09:00:00.000Z');
    expect(Folded.reminders[0].OriginalThreadTs).toBe('1773990000.300001');
  });
});
