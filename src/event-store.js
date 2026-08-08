'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { AppendFileDurableAsync } = require('./durable-write');

/**
 * NON-authoritative, append-only event store (Phase 1 counter-view).
 *
 * Scope guard: this is a SIDE LEDGER. Mutate-first behavior leads; this log MAY
 * lag or be lossy and is never the source of truth. Therefore:
 *   - `append` is best-effort: it NEVER rejects/throws. Any failure resolves
 *     `{ ok:false, error }` so a caller's reminder transition is never blocked.
 *   - Appends ARE `fsync`'d as of GH-12 Phase 4. The Phase 0 spike recorded a
 *     no-fsync reality that is no longer true; see `src/durable-write.js`
 *     (`AppendFileDurableAsync`) for the benchmark that chose the shape.
 *     This buys RECENCY, not integrity: append-only writes were already
 *     torn-tail-tolerant on read, so the ledger's failure mode was losing the
 *     last event, never corrupting earlier ones.
 *
 * One `<workspace>_events.jsonl` file per workspace under `rootDir`; one JSON
 * object per line. Appends are serialized PER WORKSPACE using the write-chain
 * idiom copied from src/completion-store.js (#WriteChain init at line 34,
 * #SchedulePersistAsync chaining via `.then()` at lines 126-129, and a persist
 * step that never rejects so the chain can't be poisoned, lines 132-138). Here
 * the single chain becomes a Map of one chain per workspace so writes to
 * different workspaces don't serialize against each other.
 */

/**
 * Closed event-type enum and the payload keys each type MUST carry, mirrored
 * from CONTRACT.md "Closed type enum (Phase 1 subset)". A projection replays
 * deterministically only if every required key is present, so an event missing
 * any of them is rejected before it can reach disk.
 * @type {Record<string, string[]>}
 */
const REQUIRED_PAYLOAD_KEYS = {
  ReminderCreated: ['text', 'assigneeId', 'sourceChannelId', 'targetChannelId', 'source', 'githubUrls'],
  ReminderScheduled: ['dueAt', 'via'],
  ReminderCompleted: ['by', 'method', 'summary', 'completedAt'],
  ReminderSnoozed: ['until', 'by'],
  ReminderCancelled: ['by', 'reason'],
  BaselineReminderImported: ['text', 'assigneeId', 'sourceChannelId', 'targetChannelId', 'dueAt', 'state'],
  // v2 additions (schema expansion). Present in the v1 map with an EMPTY v1 requirement so a v1
  // reader still recognises the type — `readAll` only checks that the type is known — while the v2
  // requirements below are what an append is actually held to.
  ReminderStateChanged: [],
  ThreadRelayStateChanged: [],
};

/**
 * SCHEMA v2 — the wider requirement set, enforced on APPEND ONLY.
 *
 * Design comes from a cross-model consult (Codex + agy, 2026-08-08) where the two disagreed. Codex
 * wanted a closed `(version,type)` registry whose unknown/invalid versions become a READ error;
 * agy argued that `readAll()` does not validate payloads today (it checks only that the type is
 * known), so making reads throw is new brittleness on the path we least want to destabilise.
 *
 * agy's design won on mechanism: v1 events keep reading exactly as before, and only newly written
 * events are held to v2. Codex's guarantee is preserved elsewhere — the parity check records the
 * event version, so a v1-only stream can never claim v2 parity and therefore can never serve a
 * projection.
 *
 * @type {Record<string, string[]>}
 */
const REQUIRED_PAYLOAD_KEYS_V2 = {
  ReminderCreated: [
    ...REQUIRED_PAYLOAD_KEYS.ReminderCreated,
    // Reconstruction fields. Event.ts is stamped when the APPEND runs, not when the reminder was
    // created, so `createdOn` cannot be substituted from it without changing raw JSON bytes.
    'createdOn', 'originalSenderId', 'originalMessageId', 'originalThreadTs',
    'originalChannelName', 'ignoreSnooze',
    // assigneeIds is the AUTHORITATIVE assignee record; assigneeId is only its deprecated
    // first-entry mirror (src/reminders-module.js:84-85). Requiring the scalar alone would let the
    // ledger quietly undo GH-22's multi-assignee support. Caught by agy in consult.
    'assigneeIds',
    'clientId',
    // Relay state's STARTING value. ThreadRelayStateChanged carries every later change, but a fold
    // still needs the initial one — and `undefined` is not it: github-comment-relay.js:102 refuses
    // to relay when GitHubRelayStopped is set, so a stream that omits the field would RESUME a relay
    // a user deliberately stopped. Always false for a native creation (a reminder that has never
    // existed cannot have relayed), but written explicitly so the fold reads a fact, not a default.
    'gitHubRelayStarted', 'gitHubRelayStopped',
  ],
  ReminderScheduled: [
    ...REQUIRED_PAYLOAD_KEYS.ReminderScheduled,
    // The live queue resets IgnoreSnooze to false before scheduling
    // (src/reminders-module.js:3455-3458). Without carrying it, a fold keeps the stale value and
    // the rebalance export publishes it to an external consumer.
    'ignoreSnooze',
  ],
  ReminderCompleted: [
    ...REQUIRED_PAYLOAD_KEYS.ReminderCompleted,
    'sourceChannelId', 'dueDate', 'clientId',
    // The authoritative CompletionRecord stamps completedMs with Date.now(); the event previously
    // re-sampled an ISO instant, so the two could never be byte-identical. v2 carries the
    // authoritative value verbatim.
    'completedMs',
  ],
  ReminderSnoozed: REQUIRED_PAYLOAD_KEYS.ReminderSnoozed,
  ReminderCancelled: REQUIRED_PAYLOAD_KEYS.ReminderCancelled,
  BaselineReminderImported: [
    ...REQUIRED_PAYLOAD_KEYS.BaselineReminderImported,
    'createdOn', 'originalSenderId', 'originalMessageId', 'originalThreadTs',
    'originalChannelName', 'ignoreSnooze', 'assigneeIds', 'clientId',
    // Unlike a native creation, an IMPORT can legitimately carry `true` here — the JSON record it
    // reads may describe a thread whose relay already started or was stopped months ago. This is
    // exactly what the enrich mode exists to backfill.
    'gitHubRelayStarted', 'gitHubRelayStopped',
  ],
  // Generic transition event. #EmitTransitionEvent previously mapped only four states and skipped
  // due/overdue/posting/posted/rescheduled/failed/dead-letter, so a fold silently retained
  // `scheduled` for a reminder that had actually gone overdue. Production persists at least
  // `overdue`, so this was not theoretical.
  ReminderStateChanged: ['fromState', 'toState', 'reason'],
  // Relay state is THREAD-scoped, not reminder-scoped: one Slack thread can affect several
  // reminders. Codex proposed fanning out to one event per reminder at emission; agy argued that
  // invents a cardinality the domain lacks and breaks when a new reminder joins an existing thread.
  // agy's design won: emit once with the thread identity, let the fold apply it to every reminder
  // sharing that thread. Thread identity is GH-27's `OriginalThreadTs ?? OriginalMessageID`.
  //
  // `reminderId` is structurally required by every event, so this one carries the synthetic
  // `thread:<threadKey>` rather than an arbitrary member reminder. Picking a member would be a lie
  // about scope AND a dangling reference once that reminder completes, while the synthetic key keeps
  // the envelope invariant intact and stays self-describing on disk. The fold dispatches on `type`
  // before any id lookup, so it never manufactures a reminder from one.
  ThreadRelayStateChanged: ['threadKey', 'relayStarted', 'relayStopped'],
};

/** Events written from now on. v1 remains readable forever. */
const CURRENT_SCHEMA_VERSION = 2;

/**
 * Validate an event against the closed enum + required payload keys. Returns the
 * normalized, ready-to-write event (with id/v/ts auto-assigned if absent) or
 * `null` when the shape is invalid — in which case the caller writes NOTHING.
 * @param {any} ArgEvent
 * @returns {object|null}
 */
function NormalizeEvent(ArgEvent) {
  if(!ArgEvent || typeof ArgEvent !== 'object' || Array.isArray(ArgEvent)) {
    return null;
  }
  if(typeof ArgEvent.type !== 'string' || !Object.prototype.hasOwnProperty.call(REQUIRED_PAYLOAD_KEYS, ArgEvent.type)) {
    return null;
  }
  if(typeof ArgEvent.reminderId !== 'string' || ArgEvent.reminderId.length === 0) {
    return null;
  }
  const Payload = ArgEvent.payload;
  if(!Payload || typeof Payload !== 'object' || Array.isArray(Payload)) {
    return null;
  }
  // Which requirement set applies. An event carrying no explicit `v` is treated as v1, so historical
  // events and any caller that has not been updated keep working unchanged.
  const Version = typeof ArgEvent.v === 'number' ? ArgEvent.v : 1;
  const RequiredKeys = Version >= 2
    ? (REQUIRED_PAYLOAD_KEYS_V2[ArgEvent.type] || REQUIRED_PAYLOAD_KEYS[ArgEvent.type])
    : REQUIRED_PAYLOAD_KEYS[ArgEvent.type];

  for(const Key of RequiredKeys) {
    // `hasOwnProperty` is NOT presence: it returns true for a key whose value is `undefined`, and
    // JSON.stringify then DROPS that key, so an event could pass validation and be written with the
    // field missing from the serialized line. Caught by Codex in consult and verified. Requiring the
    // value to be defined closes it; `null` stays legal because most of these fields are nullable.
    if(!Object.prototype.hasOwnProperty.call(Payload, Key) || Payload[Key] === undefined) {
      return null;
    }
  }
  // Shape is valid — auto-assign id/v/ts only if absent so caller-supplied
  // values (e.g. a deterministic id in a test) are preserved.
  return {
    v: Version,
    id: typeof ArgEvent.id === 'string' && ArgEvent.id.length > 0 ? ArgEvent.id : `evt_${crypto.randomUUID()}`,
    ts: typeof ArgEvent.ts === 'string' && ArgEvent.ts.length > 0 ? ArgEvent.ts : new Date().toISOString(),
    workspace: ArgEvent.workspace,
    type: ArgEvent.type,
    reminderId: ArgEvent.reminderId,
    payload: Payload,
  };
}

/**
 * Map a workspace key to its `.jsonl` path under rootDir. The workspace is
 * sanitized so it can't escape rootDir via path separators.
 * @param {string} ArgRootDir
 * @param {string} ArgWorkspace
 * @returns {string}
 */
function EventsFilePath(ArgRootDir, ArgWorkspace) {
  const Safe = String(ArgWorkspace).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(ArgRootDir, `${Safe}_events.jsonl`);
}

/**
 * @param {{ rootDir: string }} ArgOptions
 */
function createEventStore(ArgOptions) {
  const RootDir = ArgOptions && ArgOptions.rootDir;

  /**
   * One write chain per workspace. Each chain serializes that workspace's
   * appends so concurrent appends never interleave a torn line; different
   * workspaces progress independently.
   * @type {Map<string, Promise<{ ok: boolean, error?: Error }>>}
   */
  const WriteChains = new Map();

  /**
   * Memoized `mkdir -p` of the root directory.
   *
   * This used to run on every append. That was merely wasteful when an append was one unsynced
   * syscall; since GH-12 Phase 4 added `fsync` the append path is deliberately slower, so keeping
   * an avoidable syscall on it is no longer free. Reset on failure so a later append retries
   * rather than caching a rejection forever.
   * `fs.mkdir` with `recursive: true` resolves the first directory created, or `undefined` when it
   * already existed — neither is used, but the type has to admit both.
   * @type {Promise<string|undefined>|null}
   */
  let RootDirReady = null;

  /** @returns {Promise<any>} */
  function EnsureRootDirAsync() {
    if(!RootDirReady) {
      RootDirReady = fs.mkdir(RootDir, { recursive: true }).catch(ArgError => {
        RootDirReady = null;
        throw ArgError;
      });
    }
    return RootDirReady;
  }

  /**
   * Best-effort durable append. Mirrors completion-store's #PersistAsync in that
   * it NEVER rejects — it resolves a result object — so the per-workspace chain
   * can't be poisoned and a caller's transition is never blocked by a log error.
   *
   * Takes an already-serialized line rather than the event object: see `append` for why that
   * matters.
   * @param {string} ArgWorkspace
   * @param {string} ArgLine Serialized event, newline-terminated.
   * @returns {Promise<{ ok: boolean, error?: Error }>}
   */
  async function AppendDurable(ArgWorkspace, ArgLine) {
    try {
      await EnsureRootDirAsync();
      // GH-12 Phase 4: fsync the append so an event is on disk rather than in the page cache when
      // this resolves. Still best-effort — any failure resolves { ok:false } below rather than
      // throwing, so a reminder transition is never blocked by the side ledger.
      await AppendFileDurableAsync(EventsFilePath(RootDir, ArgWorkspace), ArgLine);
      return { ok: true };
    } catch(error) {
      return { ok: false, error };
    }
  }

  return {
    /**
     * Append one event to the workspace's log. NON-authoritative: resolves
     * `{ ok:false, error }` on any failure and NEVER rejects. Validates the
     * event shape BEFORE writing; an invalid event resolves `{ ok:false }` and
     * writes nothing. Serializes per workspace via the write chain.
     * @param {string} ArgWorkspace
     * @param {any} ArgEvent
     * @returns {Promise<{ ok: boolean, error?: Error }>}
     */
    append(ArgWorkspace, ArgEvent) {
      // Defensive: the whole point is to never throw at the call site, so even
      // an invalid workspace key resolves rather than rejects.
      if(typeof ArgWorkspace !== 'string' || ArgWorkspace.length === 0) {
        return Promise.resolve({ ok: false, error: new Error('event-store: workspace must be a non-empty string') });
      }
      // Stamp the workspace onto the event so the persisted line is self-describing.
      const Candidate = (ArgEvent && typeof ArgEvent === 'object' && !Array.isArray(ArgEvent))
        ? { ...ArgEvent, workspace: ArgEvent.workspace == null ? ArgWorkspace : ArgEvent.workspace }
        : ArgEvent;
      const Normalized = NormalizeEvent(Candidate);
      if(Normalized === null) {
        // Invalid shape: write nothing, don't perturb the chain.
        return Promise.resolve({ ok: false, error: new Error('event-store: invalid event shape, not written') });
      }

      // Serialize NOW, synchronously, rather than inside the chain.
      //
      // NormalizeEvent keeps a shallow reference to the caller's `payload`, so serializing later
      // would capture whatever the object looks like when the chain reaches it — not what the
      // caller passed. A caller mutating `event.payload` right after calling append() would write
      // the mutated value. Verified reproducible before this fix.
      //
      // Pre-existing, but GH-12 Phase 4 widened the window by ~57x: the chain link went from one
      // unsynced `fs.appendFile` (~0.1 ms) to an fsync'd append (~5.7 ms). Serializing at call
      // time captures the event as it was when submitted, which is the semantics callers expect,
      // and is cheaper than deep-cloning.
      let Line;
      try {
        Line = `${JSON.stringify(Normalized)}\n`;
      } catch(error) {
        // A circular or otherwise unserializable payload must not reject — this store never throws
        // at the call site.
        return Promise.resolve({ ok: false, error });
      }

      const Prior = WriteChains.get(ArgWorkspace) || Promise.resolve({ ok: true });
      // Chain off the prior write but swallow its result so one failure can't
      // reject the next link — matches completion-store's poison-proof chain.
      const Next = Prior.then(() => AppendDurable(ArgWorkspace, Line));
      WriteChains.set(ArgWorkspace, Next);
      return Next;
    },

    /**
     * Read all events for a workspace, in append order. A missing file is the
     * normal first-run case → returns `[]`. Tolerant of a corrupt/torn FINAL
     * line (an interrupted append) and of unknown event types: such lines are
     * skipped rather than throwing, per CONTRACT.md "Unknown type on read →
     * skip with a warning ... never throw."
     * @param {string} ArgWorkspace
     * @returns {Promise<object[]>}
     */
    async readAll(ArgWorkspace) {
      let Raw;
      try {
        Raw = await fs.readFile(EventsFilePath(RootDir, ArgWorkspace), 'utf8');
      } catch(error) {
        // Missing file → empty stream; any other read error also degrades to empty
        // since this is a non-authoritative read.
        return [];
      }
      const Lines = Raw.split('\n');
      const Events = [];
      for(let Index = 0; Index < Lines.length; Index += 1) {
        const Line = Lines[Index];
        if(Line.length === 0) {
          continue; // trailing newline / blank line
        }
        let Parsed;
        try {
          Parsed = JSON.parse(Line);
        } catch(error) {
          // A torn final line from an interrupted append, or any unparseable
          // line, is skipped rather than throwing.
          continue;
        }
        // Skip unknown/forward-incompatible types (forward-compatible read).
        if(!Parsed || typeof Parsed !== 'object' || !Object.prototype.hasOwnProperty.call(REQUIRED_PAYLOAD_KEYS, Parsed.type)) {
          continue;
        }
        Events.push(Parsed);
      }
      return Events;
    },
  };
}

module.exports = { createEventStore, CURRENT_SCHEMA_VERSION, REQUIRED_PAYLOAD_KEYS, REQUIRED_PAYLOAD_KEYS_V2 };
