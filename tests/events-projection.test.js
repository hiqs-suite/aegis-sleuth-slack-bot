'use strict';

// Lane B acceptance: node --test tests/events-projection.test.js
// Uses node's built-in runner (node:test + node:assert). Covers fold
// determinism, completed-in-window selection, the rebalance shape from an inline
// fixture, unknown-type tolerance, and a child_process smoke test of replay.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  foldToRebalanceShape,
  foldActive,
  foldCompleted,
  FoldReminders,
} = require('../deploy/reminders-export/events-projection.js');

const REPO_ROOT = path.join(__dirname, '..');
const REPLAY = path.join(REPO_ROOT, 'scripts', 'replay.js');

// A small fixture event array conforming to CONTRACT.md's event shape.
function FixtureEvents() {
  return [
    {
      v: 1, id: 'evt_1', ts: '2026-06-10T09:00:00Z', workspace: 'neochrome',
      type: 'ReminderCreated', reminderId: 'rem_a',
      payload: {
        text: 'ship the export', assigneeId: 'U_alice', sourceChannelId: 'C_src',
        targetChannelId: 'C_tgt', source: 'slack', githubUrls: ['https://github.com/o/r/pull/1'],
      },
    },
    {
      v: 1, id: 'evt_2', ts: '2026-06-10T09:01:00Z', workspace: 'neochrome',
      type: 'ReminderScheduled', reminderId: 'rem_a',
      payload: { dueAt: '2026-06-12T17:00:00Z', via: 'manual' },
    },
    {
      v: 1, id: 'evt_3', ts: '2026-06-10T09:02:00Z', workspace: 'neochrome',
      type: 'ReminderCreated', reminderId: 'rem_b',
      payload: {
        text: 'review PR', assigneeId: 'U_bob', sourceChannelId: 'C_src2',
        targetChannelId: 'C_tgt2', source: 'slack', githubUrls: [],
      },
    },
    {
      v: 1, id: 'evt_4', ts: '2026-06-11T12:00:00Z', workspace: 'neochrome',
      type: 'ReminderCompleted', reminderId: 'rem_b',
      payload: { by: 'U_bob', method: 'reaction', summary: 'done', completedAt: '2026-06-11T12:00:00Z' },
    },
    {
      v: 1, id: 'evt_5', ts: '2026-06-10T09:03:00Z', workspace: 'neochrome',
      type: 'BaselineReminderImported', reminderId: 'rem_c',
      payload: {
        text: 'legacy task', assigneeId: 'U_carol', sourceChannelId: 'C_src3',
        targetChannelId: 'C_tgt3', dueAt: '2026-06-20T00:00:00Z', state: 'scheduled',
        githubUrls: ['https://github.com/o/r/issues/2'],
      },
    },
    {
      v: 1, id: 'evt_6', ts: '2026-06-10T09:04:00Z', workspace: 'neochrome',
      type: 'ReminderCancelled', reminderId: 'rem_c',
      payload: { by: 'U_carol', reason: 'obsolete' },
    },
  ];
}

test('fold is deterministic — same input yields byte-identical output', () => {
  const a = JSON.stringify(foldToRebalanceShape(FixtureEvents(), { workspace: 'neochrome' }));
  const b = JSON.stringify(foldToRebalanceShape(FixtureEvents(), { workspace: 'neochrome' }));
  assert.strictEqual(a, b);
});

test('rebalance shape from a fixture has the expected envelope and records', () => {
  const out = foldToRebalanceShape(FixtureEvents(), { workspace: 'neochrome' });
  assert.strictEqual(out.workspaceName, 'neochrome');
  assert.strictEqual(out.totalReminderCount, 3); // rem_a, rem_b, rem_c
  assert.strictEqual(out.returnedReminderCount, 3);
  assert.deepStrictEqual(out.filters, { activeOnly: false, states: [] });
  assert.strictEqual(out.source.type, 'sleuth-events-projection');
  assert.ok(Array.isArray(out.reminders));

  const byId = Object.fromEntries(out.reminders.map((r) => [r.reminderId, r]));

  // rem_a: created + scheduled -> scheduled & active, carries created fields.
  assert.strictEqual(byId.rem_a.state, 'scheduled');
  assert.strictEqual(byId.rem_a.isActive, true);
  assert.strictEqual(byId.rem_a.reminderMessageText, 'ship the export');
  assert.strictEqual(byId.rem_a.assigneeId, 'U_alice');
  assert.strictEqual(byId.rem_a.shouldPostOn, '2026-06-12T17:00:00Z');
  assert.deepStrictEqual(byId.rem_a.githubUrls, ['https://github.com/o/r/pull/1']);

  // rem_b: created + completed -> completed & inactive, completion fields set.
  assert.strictEqual(byId.rem_b.state, 'completed');
  assert.strictEqual(byId.rem_b.isActive, false);
  assert.strictEqual(byId.rem_b.completedAt, '2026-06-11T12:00:00Z');
  assert.strictEqual(byId.rem_b.completedBy, 'U_bob');

  // rem_c: baseline-imported (scheduled) then cancelled -> cancelled & inactive.
  assert.strictEqual(byId.rem_c.state, 'cancelled');
  assert.strictEqual(byId.rem_c.isActive, false);
  assert.strictEqual(byId.rem_c.cancelReason, 'obsolete');
  assert.deepStrictEqual(byId.rem_c.githubUrls, ['https://github.com/o/r/issues/2']);
});

test('activeOnly filter narrows returnedReminderCount but keeps total', () => {
  const out = foldToRebalanceShape(FixtureEvents(), { workspace: 'neochrome', activeOnly: true });
  assert.strictEqual(out.totalReminderCount, 3);
  assert.strictEqual(out.returnedReminderCount, 1); // only rem_a is active
  assert.strictEqual(out.filters.activeOnly, true);
  assert.strictEqual(out.reminders[0].reminderId, 'rem_a');
});

test('foldActive returns only scheduled/snoozed reminders', () => {
  const active = foldActive(FixtureEvents());
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].reminderId, 'rem_a');
});

test('foldCompleted selects completed-in-window', () => {
  const events = FixtureEvents();
  const all = foldCompleted(events);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].reminderId, 'rem_b');

  // window that includes the completion (2026-06-11T12:00:00Z)
  const inWindow = foldCompleted(events, {
    fromMs: Date.parse('2026-06-11T00:00:00Z'),
    toMs: Date.parse('2026-06-12T00:00:00Z'),
  });
  assert.strictEqual(inWindow.length, 1);

  // window entirely before the completion -> excluded
  const beforeWindow = foldCompleted(events, {
    fromMs: Date.parse('2026-06-01T00:00:00Z'),
    toMs: Date.parse('2026-06-02T00:00:00Z'),
  });
  assert.strictEqual(beforeWindow.length, 0);
});

test('unknown event type is skipped with a warning, never throws', () => {
  const warnings = [];
  const events = FixtureEvents().concat([
    { v: 1, id: 'evt_x', ts: '2026-06-10T10:00:00Z', workspace: 'neochrome', type: 'ReminderTeleported', reminderId: 'rem_z', payload: {} },
  ]);
  const records = FoldReminders(events, { warn: (m) => warnings.push(m) });
  assert.strictEqual(records.length, 3); // rem_z skipped entirely
  assert.ok(warnings.some((w) => w.includes('unknown event type')));
});

test('replay.js prints valid JSON for --view rebalance (smoke test)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
  const fixturePath = path.join(dir, 'events.jsonl');
  const lines = FixtureEvents().map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(fixturePath, lines, 'utf8');

  const stdout = execFileSync(
    process.execPath,
    [REPLAY, fixturePath, '--view', 'rebalance', '--workspace', 'neochrome'],
    { encoding: 'utf8' }
  );

  const parsed = JSON.parse(stdout); // throws if invalid JSON
  assert.strictEqual(parsed.workspaceName, 'neochrome');
  assert.strictEqual(parsed.totalReminderCount, 3);
  assert.ok(Array.isArray(parsed.reminders));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('replay.js --view completed prints valid JSON array (smoke test)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
  const fixturePath = path.join(dir, 'events.jsonl');
  const lines = FixtureEvents().map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(fixturePath, lines, 'utf8');

  const stdout = execFileSync(
    process.execPath,
    [REPLAY, fixturePath, '--view', 'completed'],
    { encoding: 'utf8' }
  );
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed));
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].reminderId, 'rem_b');

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- schema v2: the replay/export fold must recognise the two new types ---

test('v2 transition events are recognised, not warned about as unknown', () => {
  const warnings = [];
  const events = FixtureEvents().concat([
    {
      v: 2, id: 'evt_v2_state', ts: '2026-06-11T10:00:00Z', workspace: 'neochrome',
      type: 'ReminderStateChanged', reminderId: 'rem_a',
      payload: { fromState: 'scheduled', toState: 'overdue', reason: 'due-passed' },
    },
    {
      v: 2, id: 'evt_v2_relay', ts: '2026-06-11T10:01:00Z', workspace: 'neochrome',
      type: 'ThreadRelayStateChanged', reminderId: 'thread:1773990000.000088',
      payload: { threadKey: '1773990000.000088', relayStarted: true, relayStopped: false },
    },
  ]);
  const records = FoldReminders(events, { warn: (m) => warnings.push(m) });
  assert.strictEqual(warnings.length, 0, 'a valid v2 stream must produce no forward-compat warnings');

  // The thread-scoped event must NOT mint a row keyed on its synthetic id.
  assert.strictEqual(records.length, 3);
  assert.ok(!records.some((r) => r.reminderId.startsWith('thread:')), 'no phantom reminder from a thread event');

  // The generic transition carries states the specific events never emitted.
  const remA = records.find((r) => r.reminderId === 'rem_a');
  assert.strictEqual(remA.state, 'overdue');
  assert.strictEqual(remA.isActive, false);
});

test('a v2 cancellation keeps this export cancelled spelling', () => {
  // The FSM says `canceled`; this shape has always published `cancelled`. ReminderStateChanged
  // carries the FSM spelling verbatim, so without a mapping the same cancellation would fold to a
  // different string depending on which event landed last.
  const events = FixtureEvents().concat([
    {
      v: 2, id: 'evt_v2_cancel', ts: '2026-06-10T09:05:00Z', workspace: 'neochrome',
      type: 'ReminderStateChanged', reminderId: 'rem_c',
      payload: { fromState: 'scheduled', toState: 'canceled', reason: 'obsolete' },
    },
  ]);
  const out = foldToRebalanceShape(events, { workspace: 'neochrome' });
  const remC = out.reminders.find((r) => r.reminderId === 'rem_c');
  assert.strictEqual(remC.state, 'cancelled');
  assert.strictEqual(remC.isActive, false);
});
