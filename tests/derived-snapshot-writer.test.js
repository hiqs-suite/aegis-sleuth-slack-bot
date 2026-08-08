'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { FoldReminderReadModels } = require('../src/reminders-projection');
const {
  BuildCompactedEvents,
  WriteDerivedSnapshotAsync,
  WriteSnapshotAndCompactAsync,
} = require('../src/state-snapshot-writer');

function BaselineEvent(ArgOverrides = {}) {
  return {
    id: 'evt-baseline', ts: '2026-08-01T12:00:00.000Z', workspace: 'snapshot-test',
    type: 'BaselineReminderImported', reminderId: 'rem-1',
    payload: {
      text: 'Ship the derived snapshot', assigneeId: 'U_OWNER', assigneeIds: ['U_OWNER'],
      sourceChannelId: 'C_SOURCE', targetChannelId: 'C_TARGET', dueAt: '2026-08-02T12:00:00.000Z',
      state: 'scheduled', githubUrls: ['https://github.com/acme/repo/pull/1'],
      // Required for strict parity once a reminder carries GitHub URLs (QA 2026-08-08):
      // github-comment-relay.js:102 refuses to relay when GitHubRelayStopped is set, so a fold that
      // cannot restore these would resume a relay a user stopped. Models a post-schema-expansion event.
      gitHubRelayStarted: false, gitHubRelayStopped: false,
      createdOn: '2026-08-01T12:00:00.000Z', originalSenderId: 'U_SENDER',
      originalMessageId: '123.456', originalThreadTs: '123.000', originalChannelName: 'engineering',
      ignoreSnooze: false, clientId: 'acme', projectId: 'ledger',
    },
    ...ArgOverrides,
  };
}

/** Mirror the pre-P3 reminders loader's date reviver. */
async function LoadLegacyRemindersAsync(ArgFilePath) {
  return JSON.parse(await fs.readFile(ArgFilePath, 'utf8'), (ArgKey, ArgValue) =>
    (ArgKey === 'CreatedOn' || ArgKey === 'ShouldPostOn') ? new Date(ArgValue) : ArgValue
  );
}

test('a derived snapshot is loadable by the legacy JSON loaders without conversion', async () => {
  const Root = await fs.mkdtemp(path.join(os.tmpdir(), 'derived-snapshot-'));
  const ReminderPath = path.join(Root, 'workspace_reminders.json');
  const CompletionPath = path.join(Root, 'workspace_completed.json');
  try {
    const Folded = FoldReminderReadModels([
      BaselineEvent(),
      BaselineEvent({ id: 'evt-open', reminderId: 'rem-2', payload: {
        ...BaselineEvent().payload, text: 'Keep this open', dueAt: '2026-08-04T12:00:00.000Z',
      } }),
      {
        id: 'evt-done', ts: '2026-08-03T12:00:00.000Z', workspace: 'snapshot-test',
        type: 'ReminderCompleted', reminderId: 'rem-1',
        // v2: strict mode now requires the authoritative completedMs, since a re-parsed ISO
        // instant is a different number from the one the CompletionRecord stored.
        payload: {
          by: 'U_OWNER', method: 'reaction', summary: 'Ship the derived snapshot',
          completedAt: '2026-08-03T12:00:00.000Z', completedMs: Date.parse('2026-08-03T12:00:00.000Z'),
        },
      },
    ], { strict: true });

    await WriteDerivedSnapshotAsync({
      reminderFilePath: ReminderPath, completionFilePath: CompletionPath, folded: Folded,
    });

    const LegacyReminders = await LoadLegacyRemindersAsync(ReminderPath);
    const LegacyCompleted = JSON.parse(await fs.readFile(CompletionPath, 'utf8'));
    // The fold yields JSON-ready ISO dates; the old loader's reviver is deliberately part of the
    // in-memory contract, so compare against the folded state after that same legacy hydration.
    const HydratedFoldedReminders = JSON.parse(JSON.stringify(Folded.reminders), (ArgKey, ArgValue) =>
      (ArgKey === 'CreatedOn' || ArgKey === 'ShouldPostOn') ? new Date(ArgValue) : ArgValue
    );
    assert.deepEqual(LegacyReminders, HydratedFoldedReminders);
    assert.deepEqual(LegacyCompleted, Folded.completed);
  } finally {
    await fs.rm(Root, { recursive: true, force: true });
  }
});

test('event-count compaction retains a bounded, fold-equivalent replay baseline', async () => {
  const Root = await fs.mkdtemp(path.join(os.tmpdir(), 'derived-snapshot-compact-'));
  const ReminderPath = path.join(Root, 'workspace_reminders.json');
  const CompletionPath = path.join(Root, 'workspace_completed.json');
  const EventPath = path.join(Root, 'workspace_events.jsonl');
  try {
    const Events = [BaselineEvent(), {
      id: 'evt-done', ts: '2026-08-03T12:00:00.000Z', workspace: 'snapshot-test',
      type: 'ReminderCompleted', reminderId: 'rem-1',
      payload: {
        by: 'U_OWNER', method: 'reaction', summary: 'Ship the derived snapshot',
        completedAt: '2026-08-03T12:00:00.000Z', completedMs: Date.parse('2026-08-03T12:00:00.000Z'),
      },
    }];
    const Folded = FoldReminderReadModels(Events, { strict: true });
    const Result = await WriteSnapshotAndCompactAsync({
      reminderFilePath: ReminderPath, completionFilePath: CompletionPath, eventFilePath: EventPath,
      workspace: 'snapshot-test', events: Events, folded: Folded, compactionEventCount: 2,
    });
    assert.equal(Result.compacted, true);
    const Compacted = (await fs.readFile(EventPath, 'utf8')).trim().split('\n').map(ArgLine => JSON.parse(ArgLine));
    assert.equal(Compacted.length, Result.replayEventCount);
    assert.deepEqual(FoldReminderReadModels(Compacted, { strict: true }), Folded);

    // This is the rollback assertion: turning the log reader off uses the freshly-derived legacy
    // snapshot and loses none of the state written while the log was authoritative.
    assert.deepEqual(await LoadLegacyRemindersAsync(ReminderPath), Folded.reminders);
    assert.deepEqual(JSON.parse(await fs.readFile(CompletionPath, 'utf8')), Folded.completed);
  } finally {
    await fs.rm(Root, { recursive: true, force: true });
  }
});

test('compacted baseline construction is deterministic and contains no historical transition tail', () => {
  const Folded = FoldReminderReadModels([BaselineEvent()], { strict: true });
  const First = BuildCompactedEvents({ workspace: 'snapshot-test', folded: Folded });
  const Second = BuildCompactedEvents({ workspace: 'snapshot-test', folded: Folded });
  assert.deepEqual(First, Second);
  assert.equal(First.length, 1);
  assert.equal(First[0].type, 'BaselineReminderImported');
});

test('compaction preserves relay state for an OPEN relay-capable reminder', () => {
  // Compaction REPLACES the log. A field dropped here is gone for good — there is no earlier event
  // left to recover it from — so a compacted baseline that lost GitHubRelayStopped would resume a
  // relay the user deliberately stopped, permanently. The open path had no coverage for this.
  const Folded = FoldReminderReadModels([
    BaselineEvent({ payload: {
      ...BaselineEvent().payload, gitHubRelayStopped: true, gitHubRelayStarted: true,
    } }),
  ], { strict: true });
  assert.equal(Folded.reminders.length, 1);

  const Compacted = BuildCompactedEvents({ workspace: 'snapshot-test', folded: Folded });
  const ReFolded = FoldReminderReadModels(Compacted, { strict: true });
  assert.deepEqual(ReFolded, Folded, 'a compacted log must fold to the same state it was built from');
  assert.equal(ReFolded.reminders[0].GitHubRelayStopped, true);
  assert.equal(ReFolded.reminders[0].GitHubRelayStarted, true);
});
