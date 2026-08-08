'use strict';

// Uses node's built-in runner so `node --test tests/event-store.test.js` runs
// standalone (the repo's other suites run under Jest, whose describe/test/expect
// globals are NOT present under `node --test`). Acceptance per CONTRACT.md
// "Lane A": append success, per-workspace ordering, invalid-event rejection
// (returns {ok:false}, writes nothing), append-failure-is-non-fatal, and
// corrupt-tail-tolerant readAll.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { createEventStore } = require('../src/event-store');

/**
 * A minimal valid ReminderCreated event carrying every required payload key.
 * @param {object} ArgOverrides
 */
function MakeCreated(ArgOverrides = {}) {
  return {
    type: 'ReminderCreated',
    reminderId: 'rem_1',
    payload: {
      text: 'do the thing',
      assigneeId: 'U123',
      sourceChannelId: 'C1',
      targetChannelId: 'C2',
      source: 'slack',
      githubUrls: [],
    },
    ...ArgOverrides,
  };
}

/** @returns {Promise<string>} a fresh temp rootDir under os.tmpdir(). */
async function MakeRootDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'event-store-'));
}

test('append writes one valid JSONL line with auto-assigned id/v/ts', async (t) => {
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });

  const Result = await Store.append('acme', MakeCreated());
  assert.strictEqual(Result.ok, true, 'append should report ok');

  const FileText = await fs.readFile(path.join(RootDir, 'acme_events.jsonl'), 'utf8');
  const Lines = FileText.split('\n').filter(Boolean);
  assert.strictEqual(Lines.length, 1, 'exactly one line written');

  const Written = JSON.parse(Lines[0]);
  assert.strictEqual(Written.v, 1, 'v defaults to 1');
  assert.match(Written.id, /^evt_/, 'id is auto-assigned with evt_ prefix');
  assert.strictEqual(typeof Written.ts, 'string', 'ts is auto-assigned');
  assert.doesNotThrow(() => new Date(Written.ts).toISOString(), 'ts is ISO-parseable');
  assert.strictEqual(Written.workspace, 'acme', 'workspace stamped onto the event');
  assert.strictEqual(Written.type, 'ReminderCreated');
  assert.strictEqual(Written.payload.text, 'do the thing');
});

test('append preserves caller-supplied id/v/ts when present', async (t) => {
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });

  await Store.append('acme', MakeCreated({ id: 'evt_fixed', v: 1, ts: '2026-06-12T14:03:22Z' }));
  const [Event] = await Store.readAll('acme');
  assert.strictEqual(Event.id, 'evt_fixed');
  assert.strictEqual(Event.ts, '2026-06-12T14:03:22Z');
});

test('appends are ordered and isolated per workspace', async (t) => {
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });

  // Fire many appends across two workspaces without awaiting between them to
  // exercise the per-workspace write chain (no torn/interleaved lines).
  const Pending = [];
  for(let Index = 0; Index < 10; Index += 1) {
    Pending.push(Store.append('alpha', MakeCreated({ id: `evt_a${Index}`, reminderId: `rem_a${Index}` })));
    Pending.push(Store.append('beta', MakeCreated({ id: `evt_b${Index}`, reminderId: `rem_b${Index}` })));
  }
  const Results = await Promise.all(Pending);
  assert.ok(Results.every(r => r.ok === true), 'all appends succeeded');

  const Alpha = await Store.readAll('alpha');
  const Beta = await Store.readAll('beta');

  assert.deepStrictEqual(Alpha.map(e => e.id), Array.from({ length: 10 }, (_, i) => `evt_a${i}`),
    'alpha events are in append order');
  assert.deepStrictEqual(Beta.map(e => e.id), Array.from({ length: 10 }, (_, i) => `evt_b${i}`),
    'beta events are in append order');
  assert.ok(Alpha.every(e => e.workspace === 'alpha'), 'no beta events leaked into alpha');
});

test('every closed enum type with required payload keys is accepted', async (t) => {
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });

  const Samples = [
    { type: 'ReminderScheduled', reminderId: 'rem_s', payload: { dueAt: 'x', via: 'y' } },
    { type: 'ReminderCompleted', reminderId: 'rem_c', payload: { by: 'u', method: 'reaction', summary: 's', completedAt: 't' } },
    { type: 'ReminderSnoozed', reminderId: 'rem_z', payload: { until: 't', by: 'u' } },
    { type: 'ReminderCancelled', reminderId: 'rem_x', payload: { by: 'u', reason: 'r' } },
    { type: 'BaselineReminderImported', reminderId: 'rem_b', payload: { text: 't', assigneeId: 'u', sourceChannelId: 'c', targetChannelId: 'c2', dueAt: 'd', state: 'active' } },
  ];
  for(const Event of Samples) {
    const Result = await Store.append('ws', Event);
    assert.strictEqual(Result.ok, true, `${Event.type} should be accepted`);
  }
  const All = await Store.readAll('ws');
  assert.strictEqual(All.length, Samples.length, 'all valid events readable');
});

test('invalid events return {ok:false} and write nothing', async (t) => {
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });

  const BadEvents = [
    null,
    42,
    {},
    { type: 'NotARealType', reminderId: 'rem_1', payload: {} }, // unknown type
    { type: 'ReminderCreated', reminderId: 'rem_1' }, // missing payload
    { type: 'ReminderScheduled', reminderId: 'rem_1', payload: { dueAt: 'x' } }, // missing 'via'
    { type: 'ReminderScheduled', payload: { dueAt: 'x', via: 'y' } }, // missing reminderId
  ];
  for(const Bad of BadEvents) {
    const Result = await Store.append('ws', Bad);
    assert.strictEqual(Result.ok, false, `invalid event should return ok:false: ${JSON.stringify(Bad)}`);
    assert.ok(Result.error instanceof Error, 'an error is provided on rejection');
  }

  // Nothing should have been written — the file must not exist (or be empty).
  let Exists = true;
  try {
    await fs.access(path.join(RootDir, 'ws_events.jsonl'));
  } catch {
    Exists = false;
  }
  assert.strictEqual(Exists, false, 'no file created for invalid-only appends');
  assert.deepStrictEqual(await Store.readAll('ws'), [], 'readAll empty after only invalid appends');
});

test('append never throws when the target is unwritable (non-fatal)', async (t) => {
  // Point rootDir at a path whose PARENT is a regular file, so mkdir/appendFile
  // cannot succeed. append must resolve {ok:false}, not reject or throw.
  const Base = await MakeRootDir();
  t.after(() => fs.rm(Base, { recursive: true, force: true }));
  const FilePath = path.join(Base, 'iamafile');
  await fs.writeFile(FilePath, 'blocker', 'utf8');
  const BadRootDir = path.join(FilePath, 'nested'); // under a file → ENOTDIR

  const Store = createEventStore({ rootDir: BadRootDir });

  let Result;
  await assert.doesNotReject(async () => {
    Result = await Store.append('ws', MakeCreated());
  }, 'append must never reject');
  assert.strictEqual(Result.ok, false, 'unwritable target yields ok:false');
  assert.ok(Result.error instanceof Error, 'the underlying error is surfaced');

  // A subsequent append on the same (still broken) workspace also stays non-fatal,
  // proving the write chain was not poisoned by the prior failure.
  const Second = await Store.append('ws', MakeCreated());
  assert.strictEqual(Second.ok, false, 'chain survives a prior failure');
});

test('readAll on a missing workspace returns []', async (t) => {
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });
  assert.deepStrictEqual(await Store.readAll('never-written'), []);
});

test('readAll tolerates a corrupt/torn final line', async (t) => {
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });

  await Store.append('ws', MakeCreated({ id: 'evt_good1', reminderId: 'rem_1' }));
  await Store.append('ws', MakeCreated({ id: 'evt_good2', reminderId: 'rem_2' }));

  // Simulate an interrupted append: a partial JSON object with no trailing newline.
  fsSync.appendFileSync(path.join(RootDir, 'ws_events.jsonl'), '{"v":1,"id":"evt_torn","type":"Remind');

  const Events = await Store.readAll('ws');
  assert.deepStrictEqual(Events.map(e => e.id), ['evt_good1', 'evt_good2'],
    'good lines returned, torn final line skipped');
});

test('readAll skips unknown event types (forward-compatible)', async (t) => {
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });

  await Store.append('ws', MakeCreated({ id: 'evt_known', reminderId: 'rem_1' }));
  // A well-formed JSON line carrying a future/unknown type.
  fsSync.appendFileSync(
    path.join(RootDir, 'ws_events.jsonl'),
    `${JSON.stringify({ v: 1, id: 'evt_future', ts: '2026-06-12T00:00:00Z', workspace: 'ws', type: 'FutureEvent', reminderId: 'rem_9', payload: {} })}\n`,
  );

  const Events = await Store.readAll('ws');
  assert.deepStrictEqual(Events.map(e => e.id), ['evt_known'], 'unknown type skipped, never thrown');
});

// GH-12 Phase 4 (agy review). NormalizeEvent keeps a shallow reference to the caller's payload, so
// serializing inside the write chain captured whatever the object looked like when the chain got
// there — not what the caller submitted. Pre-existing, but Phase 4 widened the window ~57x by
// making each chain link an fsync'd append (~5.7ms) instead of an unsynced one (~0.1ms).
test('append snapshots the payload at call time, not at write time', async () => {
  const RootDir = await MakeRootDir();
  const Store = createEventStore({ rootDir: RootDir });

  const Event = MakeCreated({ id: 'evt_snap', reminderId: 'rem_snap' });
  Event.payload.text = 'ORIGINAL';
  const Pending = Store.append('ws', Event);
  // Caller mutates synchronously, before the chain reaches the write.
  Event.payload.text = 'MUTATED-AFTER-APPEND';
  await Pending;

  const Events = await Store.readAll('ws');
  assert.strictEqual(Events[0].payload.text, 'ORIGINAL', 'must persist the value submitted, not a later mutation');
});

// append() must never reject at the call site, so an unserializable payload resolves { ok:false }.
test('a circular payload resolves ok:false instead of throwing', async () => {
  const RootDir = await MakeRootDir();
  const Store = createEventStore({ rootDir: RootDir });

  const Event = MakeCreated({ id: 'evt_circ', reminderId: 'rem_circ' });
  Event.payload.self = Event.payload;

  const Result = await Store.append('ws', Event);
  assert.strictEqual(Result.ok, false, 'unserializable payload must not be written');
  assert.ok(Result.error, 'and must report an error rather than throwing');
});

// The root directory is created once per store, not once per append — it sits on the fsync'd
// hot path now, so an avoidable syscall there is no longer free.
test('appends still work after the root dir is created once', async () => {
  const RootDir = await MakeRootDir();
  const Store = createEventStore({ rootDir: RootDir });

  await Store.append('ws', MakeCreated({ id: 'evt_a', reminderId: 'rem_a' }));
  await Store.append('ws', MakeCreated({ id: 'evt_b', reminderId: 'rem_b' }));

  const Events = await Store.readAll('ws');
  assert.deepStrictEqual(Events.map(e => e.id), ['evt_a', 'evt_b']);
});

// --- schema v2: the wider requirement set applies to WRITES ONLY ---

const { CURRENT_SCHEMA_VERSION, REQUIRED_PAYLOAD_KEYS_V2 } = require('../src/event-store');

/** A ReminderCreated carrying every v2 key. */
function MakeCreatedV2(ArgOverrides = {}) {
  const Base = MakeCreated();
  return {
    ...Base,
    v: CURRENT_SCHEMA_VERSION,
    payload: {
      ...Base.payload,
      createdOn: '2026-08-08T09:00:00.000Z',
      originalSenderId: 'U_SENDER',
      originalMessageId: '123.456',
      originalThreadTs: null,
      originalChannelName: 'engineering',
      ignoreSnooze: false,
      assigneeIds: ['U123'],
      clientId: null,
      gitHubRelayStarted: false,
      gitHubRelayStopped: false,
    },
    ...ArgOverrides,
  };
}

test('a v1 event is still accepted unchanged after v2 lands', async (t) => {
  // The whole point of gating on the event's own version: historical writers and every event
  // already on disk keep working. If this ever fails, the migration became breaking.
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });

  const Result = await Store.append('acme', MakeCreated());
  assert.strictEqual(Result.ok, true, 'a v1-shaped event must still be accepted');
  const Events = await Store.readAll('acme');
  assert.strictEqual(Events[0].v, 1);
});

test('a v2 event missing a v2-only key is rejected and writes nothing', async (t) => {
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });

  for(const Key of ['assigneeIds', 'createdOn', 'gitHubRelayStopped', 'clientId']) {
    const Event = MakeCreatedV2();
    delete Event.payload[Key];
    const Result = await Store.append('acme', Event);
    assert.strictEqual(Result.ok, false, `a v2 event missing ${Key} must be rejected`);
  }
  assert.deepStrictEqual(await Store.readAll('acme'), [], 'no rejected event reaches disk');
});

test('a payload key present but explicitly undefined is rejected', async (t) => {
  // hasOwnProperty alone returns true here, and JSON.stringify then DROPS the key — so the event
  // would validate and be written with the field missing from the serialized line.
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });

  const Event = MakeCreatedV2();
  Event.payload.assigneeIds = undefined;
  const Result = await Store.append('acme', Event);
  assert.strictEqual(Result.ok, false, 'an undefined required value must not pass validation');
  assert.deepStrictEqual(await Store.readAll('acme'), []);
});

test('a required value of null is still legal', async (t) => {
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });

  const Event = MakeCreatedV2();
  Event.payload.clientId = null;
  Event.payload.originalThreadTs = null;
  assert.strictEqual((await Store.append('acme', Event)).ok, true, 'most of these fields are nullable');
});

test('ThreadRelayStateChanged round-trips with its synthetic thread envelope', async (t) => {
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });

  const Result = await Store.append('acme', {
    v: CURRENT_SCHEMA_VERSION,
    type: 'ThreadRelayStateChanged',
    reminderId: 'thread:1773990000.000088',
    payload: { threadKey: '1773990000.000088', relayStarted: true, relayStopped: false },
  });
  assert.strictEqual(Result.ok, true);

  const Events = await Store.readAll('acme');
  assert.strictEqual(Events.length, 1);
  assert.strictEqual(Events[0].payload.threadKey, '1773990000.000088');
  assert.strictEqual(Events[0].reminderId, 'thread:1773990000.000088');
});

test('a v2 event of a NEW type missing a required key is rejected', async (t) => {
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });

  const Missing = await Store.append('acme', {
    v: CURRENT_SCHEMA_VERSION,
    type: 'ReminderStateChanged',
    reminderId: 'rem_1',
    payload: { fromState: 'scheduled', toState: 'overdue' }, // no `reason`
  });
  assert.strictEqual(Missing.ok, false);
  assert.deepStrictEqual(await Store.readAll('acme'), []);
});

test('a v1-versioned event of a v2-only type is accepted — v1 requires nothing of it', async (t) => {
  // The two new types are registered in the v1 map with an EMPTY requirement so a v1 READER
  // recognises them. That deliberately means a v1-stamped one is not held to the v2 payload.
  const RootDir = await MakeRootDir();
  t.after(() => fs.rm(RootDir, { recursive: true, force: true }));
  const Store = createEventStore({ rootDir: RootDir });

  const Result = await Store.append('acme', {
    v: 1, type: 'ReminderStateChanged', reminderId: 'rem_1', payload: {},
  });
  assert.strictEqual(Result.ok, true);
  assert.ok(REQUIRED_PAYLOAD_KEYS_V2.ReminderStateChanged.length > 0, 'while v2 does require a payload');
});
