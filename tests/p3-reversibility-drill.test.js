'use strict';

// Release-gate drill for the Ledger authority switches. This file intentionally checks the
// runtime seams, not only the pure projection helpers: a passing helper test is not evidence
// that an operator can roll a running workspace back safely.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const fssync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FoldReminderReadModels, ReadWithProjectionFallbackAsync } = require('../src/reminders-projection');
const { WriteDerivedSnapshotAsync } = require('../src/state-snapshot-writer');

const RemindersModulePath = path.join(__dirname, '..', 'src', 'reminders-module.js');
const WebApiPath = path.join(__dirname, '..', 'src', 'web-api.js');

function BaselineEvent(ArgReminderId, ArgText) {
  return {
    v: 1,
    id: `baseline-${ArgReminderId}`,
    ts: '2026-08-08T12:00:00.000Z',
    workspace: 'reversibility-drill',
    type: 'BaselineReminderImported',
    reminderId: ArgReminderId,
    payload: {
      text: ArgText,
      assigneeId: 'U_OWNER',
      assigneeIds: ['U_OWNER'],
      sourceChannelId: 'C_SOURCE',
      targetChannelId: 'C_TARGET',
      dueAt: '2026-08-09T12:00:00.000Z',
      state: 'scheduled',
      githubUrls: [],
      createdOn: '2026-08-08T12:00:00.000Z',
      originalSenderId: 'U_OWNER',
      originalMessageId: `message-${ArgReminderId}`,
      originalThreadTs: `thread-${ArgReminderId}`,
      originalChannelName: 'engineering',
      ignoreSnooze: false,
      clientId: 'acme',
      projectId: 'ledger',
    },
  };
}

function ReadLegacyReminders(ArgFilePath) {
  return JSON.parse(fssync.readFileSync(ArgFilePath, 'utf8'), (ArgKey, ArgValue) =>
    (ArgKey === 'CreatedOn' || ArgKey === 'ShouldPostOn') ? new Date(ArgValue) : ArgValue
  );
}

test('P8 stop gate: every declared source switch is wired to its live owning reader', () => {
  const RemindersModuleSource = fssync.readFileSync(RemindersModulePath, 'utf8');
  const WebApiSource = fssync.readFileSync(WebApiPath, 'utf8');

  // Phase 4/6a: boot from the log and continuously refresh the rollback snapshot.
  assert.ok(RemindersModuleSource.includes('REMINDER_STATE_SOURCE'), 'REMINDER_STATE_SOURCE must select the boot source');
  assert.ok(RemindersModuleSource.includes('state-snapshot-writer'), 'log-authoritative writes must refresh the derived snapshot');

  // Phase 6: these flags only count if their public readers consume them. The generic helper is
  // deliberately insufficient; an unwired flag is neither a cutover nor a rollback mechanism.
  //
  // OWNERSHIP CORRECTED 2026-08-08 (QA round 4 nit): COMPLETED_READ_SOURCE was asserted against
  // RemindersModule, but its only production call site is the dashboard completed-store reader at
  // src/web-api.js:405-423. Asserting the wrong owner would have made this gate pass on a file that
  // never consumes the flag, or fail on one that was never supposed to — either way it would not be
  // checking the thing it claims to check.
  assert.ok(RemindersModuleSource.includes('REMINDERS_READ_SOURCE'), 'REMINDERS_READ_SOURCE must be consumed by RemindersModule');
  assert.ok(WebApiSource.includes('COMPLETED_READ_SOURCE'), 'COMPLETED_READ_SOURCE must be consumed by the WebAPI completed-store reader');
  assert.ok(WebApiSource.includes('REBALANCE_EXPORT_SOURCE'), 'REBALANCE_EXPORT_SOURCE must be consumed by the export owner');
});

test('a fresh derived snapshot retains create, complete, and cancel work for the legacy reader', async () => {
  const Root = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-reversibility-'));
  const ReminderPath = path.join(Root, 'workspace_reminders.json');
  const CompletedPath = path.join(Root, 'workspace_completed.json');
  try {
    const Events = [
      BaselineEvent('rem-open', 'Keep open'),
      BaselineEvent('rem-complete', 'Complete me'),
      BaselineEvent('rem-cancel', 'Cancel me'),
      {
        v: 1, id: 'complete-rem-complete', ts: '2026-08-08T13:00:00.000Z', workspace: 'reversibility-drill',
        type: 'ReminderCompleted', reminderId: 'rem-complete',
        payload: { by: 'U_OWNER', method: 'reaction', summary: 'Complete me', completedAt: '2026-08-08T13:00:00.000Z' },
      },
      {
        v: 1, id: 'cancel-rem-cancel', ts: '2026-08-08T14:00:00.000Z', workspace: 'reversibility-drill',
        type: 'ReminderCancelled', reminderId: 'rem-cancel',
        payload: { by: 'U_OWNER', reason: 'no longer needed' },
      },
    ];
    const Folded = FoldReminderReadModels(Events, { strict: true });
    await WriteDerivedSnapshotAsync({ reminderFilePath: ReminderPath, completionFilePath: CompletedPath, folded: Folded });

    assert.deepEqual(ReadLegacyReminders(ReminderPath), JSON.parse(JSON.stringify(Folded.reminders), (ArgKey, ArgValue) =>
      (ArgKey === 'CreatedOn' || ArgKey === 'ShouldPostOn') ? new Date(ArgValue) : ArgValue
    ));
    assert.deepEqual(JSON.parse(await fs.readFile(CompletedPath, 'utf8')), Folded.completed);
    assert.deepEqual(Folded.reminders.map(ArgReminder => ArgReminder.ReminderID), ['rem-open']);
    assert.deepEqual(Folded.completed.map(ArgReminder => ArgReminder.reminderId), ['rem-complete']);
  } finally {
    await fs.rm(Root, { recursive: true, force: true });
  }
});

test('a stale snapshot identifies exactly the newer completion and cancellation it would resurrect', () => {
  const BeforeLatestEvents = [
    BaselineEvent('rem-open', 'Keep open'),
    BaselineEvent('rem-complete', 'Complete me'),
    BaselineEvent('rem-cancel', 'Cancel me'),
  ];
  const LatestEvents = BeforeLatestEvents.concat([
    {
      v: 1, id: 'complete-rem-complete', ts: '2026-08-08T13:00:00.000Z', workspace: 'reversibility-drill',
      type: 'ReminderCompleted', reminderId: 'rem-complete',
      payload: { by: 'U_OWNER', method: 'reaction', summary: 'Complete me', completedAt: '2026-08-08T13:00:00.000Z' },
    },
    {
      v: 1, id: 'cancel-rem-cancel', ts: '2026-08-08T14:00:00.000Z', workspace: 'reversibility-drill',
      type: 'ReminderCancelled', reminderId: 'rem-cancel', payload: { by: 'U_OWNER', reason: 'no longer needed' },
    },
  ]);
  const Stale = FoldReminderReadModels(BeforeLatestEvents, { strict: true });
  const Current = FoldReminderReadModels(LatestEvents, { strict: true });
  const CurrentActiveIds = new Set(Current.reminders.map(ArgReminder => ArgReminder.ReminderID));
  const ResurrectedIds = Stale.reminders
    .map(ArgReminder => ArgReminder.ReminderID)
    .filter(ArgReminderId => !CurrentActiveIds.has(ArgReminderId));

  assert.deepEqual(ResurrectedIds, ['rem-complete', 'rem-cancel']);
});

// REWRITTEN 2026-08-08 after QA. This asserted `On.value === 'projection'` for all three flags —
// i.e. that enabling one SERVES the projection. That is now the opposite of the contract: all three
// are in BLOCKED_PROJECTION_FLAGS because their folds are known-lossy (short ledger on a torn
// append; stale IgnoreSnooze after reschedule; completedMs sampled at a different instant).
//
// This file is currently unregistered — it is in jest.testPathIgnorePatterns and absent from
// test:node — so the stale assertion was not failing anything. It was still a landmine: p8 owns this
// drill and re-registers it as its own deliverable, at which point the old assertion would have
// failed the gate for the wrong reason, or worse, been "fixed" by weakening the block.
test('the three Phase 6 read flags are all blocked and never reach the projection reader', async () => {
  const ReadAuthoritativeAsync = async () => 'json';
  for(const FlagName of ['REMINDERS_READ_SOURCE', 'COMPLETED_READ_SOURCE', 'REBALANCE_EXPORT_SOURCE']) {
    for(const Environment of [{ [FlagName]: 'projection' }, {}]) {
      let ProjectionRead = false;
      const Result = await ReadWithProjectionFallbackAsync({
        flagName: FlagName,
        environment: Environment,
        Logger: { warn: () => {} },
        ReadAuthoritativeAsync,
        ReadProjectionAsync: async () => { ProjectionRead = true; return 'projection'; },
      });
      assert.equal(Result.value, 'json', `${FlagName} must serve the authoritative store`);
      assert.equal(Result.source, 'authoritative');
      assert.equal(ProjectionRead, false, `${FlagName} must not even read the projection while blocked`);
    }
  }
});
