'use strict';

// Pure projection (a fold) over an Event[] stream — the read side ("Lane B").
// This module is the consumer half of the
// NON-authoritative counter-view: it NEVER reads the event store module, never
// performs I/O, and never calls Slack or GitHub. It only folds a plain array of
// events into the rebalance export shape.
//
// Target shape is the `?format=rebalance` export envelope produced by
// src/web-api.js#BuildRebalanceReminderExportAsync (envelope: web-api.js:528-548;
// per-reminder record: web-api.js:407-423). We reproduce the field names of that
// shape so a consumer (e.g. the rebalance-OS dashboard) sees a familiar object.
// Volatile/Slack-derived presentation (permalinks, display names, age, bucket
// ordering) is intentionally omitted — a pure replay cannot call Slack.
//
// CommonJS to match deploy/reminders-export/export-payload.js (export-payload.js:1,31).

/**
 * The closed event-type enum from CONTRACT.md (Phase 1 subset). Any event whose
 * `type` is not in this set is skipped with a warning (forward-compatible).
 */
const KNOWN_EVENT_TYPES = new Set([
  'ReminderCreated',
  'ReminderScheduled',
  'ReminderCompleted',
  'ReminderSnoozed',
  'ReminderCancelled',
  'BaselineReminderImported',
  // Schema v2. Recognised here so replay.js does not warn on every transition in a v2 stream and,
  // more importantly, so ThreadRelayStateChanged never reaches the record-creating path below — its
  // envelope carries the synthetic `thread:<key>` id, which would otherwise fold into a phantom
  // reminder in the export.
  'ReminderStateChanged',
  'ThreadRelayStateChanged',
]);

/**
 * Event types that are known but contribute NOTHING to the rebalance shape, so they must be dropped
 * before a per-reminder record is created for them.
 *
 * ThreadRelayStateChanged is thread-scoped: it has no reminder id of its own, and this export does
 * not surface relay state at all. Adding it here (rather than to KNOWN_EVENT_TYPES alone) is what
 * keeps `thread:<key>` from becoming a reminder row.
 */
const NON_REMINDER_EVENT_TYPES = new Set([
  'ThreadRelayStateChanged',
]);

/**
 * Map the FSM's state vocabulary (RemindersModule.ReminderState) onto this export's.
 *
 * They agree on everything except cancellation: the FSM says `canceled`, this shape has always
 * emitted `cancelled`. Before v2 that never surfaced, because the state came from a
 * ReminderCancelled case that hardcoded the double-l spelling. ReminderStateChanged carries the FSM
 * spelling verbatim, so without this the same cancellation would fold to a different string
 * depending on which event landed last — a silent vocabulary change in a published export.
 * @type {Record<string, string>}
 */
const STATE_VOCABULARY = { canceled: 'cancelled' };

/**
 * Reminder lifecycle states used by the rebalance shape. Mirrors the state
 * vocabulary web-api.js emits (e.g. 'scheduled', 'completed', 'cancelled').
 */
const ACTIVE_STATES = new Set(['scheduled', 'snoozed']);

/**
 * @typedef {Object} Event
 * @property {number} [v]
 * @property {string} [id]
 * @property {string} [ts]
 * @property {string} [workspace]
 * @property {string} type
 * @property {string} reminderId
 * @property {any} [payload]
 */

/**
 * @typedef {Object} ReminderRecord
 * @property {string}       reminderId
 * @property {string}       state
 * @property {boolean}      isActive
 * @property {string|null}  createdOn
 * @property {string|null}  shouldPostOn
 * @property {string}       reminderMessageText
 * @property {string|null}  assigneeId
 * @property {string|null}  sourceChannelId
 * @property {string|null}  targetChannelId
 * @property {string|null}  source
 * @property {string[]}     githubUrls
 * @property {string|null}  completedAt
 * @property {string|null}  completedBy
 * @property {string|null}  completionMethod
 * @property {string|null}  completionSummary
 * @property {string|null}  snoozedUntil
 * @property {string|null}  cancelledBy
 * @property {string|null}  cancelReason
 */

/**
 * Build a fresh per-reminder record skeleton in the rebalance field shape.
 * @param {string} ArgReminderId
 * @returns {ReminderRecord}
 */
function MakeReminderRecord(ArgReminderId) {
  return {
    reminderId: ArgReminderId,
    state: 'unknown',
    isActive: false,
    createdOn: null,
    shouldPostOn: null,
    reminderMessageText: '',
    assigneeId: null,
    sourceChannelId: null,
    targetChannelId: null,
    source: null,
    githubUrls: [],
    completedAt: null,
    completedBy: null,
    completionMethod: null,
    completionSummary: null,
    snoozedUntil: null,
    cancelledBy: null,
    cancelReason: null,
  };
}

/**
 * Decide whether a reminder state counts as active.
 * @param {string} ArgState
 * @returns {boolean}
 */
function IsActiveState(ArgState) {
  return ACTIVE_STATES.has(ArgState);
}

/**
 * Apply a single event to the per-reminder record (in place). Pure w.r.t. the
 * outside world; mutates only the passed record which the caller owns.
 * @param {ReminderRecord} ArgRecord
 * @param {Event} ArgEvent
 */
function ApplyEvent(ArgRecord, ArgEvent) {
  const Payload = (ArgEvent && ArgEvent.payload) || {};
  switch (ArgEvent.type) {
    case 'ReminderCreated':
      ArgRecord.reminderMessageText = typeof Payload.text === 'string' ? Payload.text : ArgRecord.reminderMessageText;
      ArgRecord.assigneeId = Payload.assigneeId != null ? Payload.assigneeId : ArgRecord.assigneeId;
      ArgRecord.sourceChannelId = Payload.sourceChannelId != null ? Payload.sourceChannelId : ArgRecord.sourceChannelId;
      ArgRecord.targetChannelId = Payload.targetChannelId != null ? Payload.targetChannelId : ArgRecord.targetChannelId;
      ArgRecord.source = Payload.source != null ? Payload.source : ArgRecord.source;
      ArgRecord.githubUrls = Array.isArray(Payload.githubUrls) ? Payload.githubUrls.slice() : ArgRecord.githubUrls;
      ArgRecord.createdOn = ArgRecord.createdOn != null ? ArgRecord.createdOn : (ArgEvent.ts != null ? ArgEvent.ts : null);
      if (ArgRecord.state === 'unknown') ArgRecord.state = 'created';
      break;

    case 'ReminderScheduled':
      ArgRecord.shouldPostOn = Payload.dueAt != null ? Payload.dueAt : ArgRecord.shouldPostOn;
      ArgRecord.state = 'scheduled';
      break;

    case 'ReminderCompleted':
      ArgRecord.state = 'completed';
      ArgRecord.completedAt = Payload.completedAt != null ? Payload.completedAt : (ArgEvent.ts != null ? ArgEvent.ts : null);
      ArgRecord.completedBy = Payload.by != null ? Payload.by : null;
      ArgRecord.completionMethod = Payload.method != null ? Payload.method : null;
      ArgRecord.completionSummary = Payload.summary != null ? Payload.summary : null;
      break;

    case 'ReminderSnoozed':
      ArgRecord.state = 'snoozed';
      ArgRecord.snoozedUntil = Payload.until != null ? Payload.until : null;
      // a snooze can move the due time forward
      if (Payload.until != null) ArgRecord.shouldPostOn = Payload.until;
      break;

    case 'ReminderCancelled':
      ArgRecord.state = 'cancelled';
      ArgRecord.cancelledBy = Payload.by != null ? Payload.by : null;
      ArgRecord.cancelReason = Payload.reason != null ? Payload.reason : null;
      break;

    case 'BaselineReminderImported':
      ArgRecord.reminderMessageText = typeof Payload.text === 'string' ? Payload.text : ArgRecord.reminderMessageText;
      ArgRecord.assigneeId = Payload.assigneeId != null ? Payload.assigneeId : ArgRecord.assigneeId;
      ArgRecord.sourceChannelId = Payload.sourceChannelId != null ? Payload.sourceChannelId : ArgRecord.sourceChannelId;
      ArgRecord.targetChannelId = Payload.targetChannelId != null ? Payload.targetChannelId : ArgRecord.targetChannelId;
      ArgRecord.githubUrls = Array.isArray(Payload.githubUrls) ? Payload.githubUrls.slice() : ArgRecord.githubUrls;
      ArgRecord.shouldPostOn = Payload.dueAt != null ? Payload.dueAt : ArgRecord.shouldPostOn;
      ArgRecord.createdOn = ArgRecord.createdOn != null ? ArgRecord.createdOn : (ArgEvent.ts != null ? ArgEvent.ts : null);
      ArgRecord.state = typeof Payload.state === 'string' ? Payload.state : ArgRecord.state;
      break;

    case 'ReminderStateChanged': {
      // v2 generic transition — the only event covering due/overdue/posting/posted/rescheduled/
      // failed/dead-letter, which the specific cases above never emitted. Ignore a non-string or
      // empty toState rather than clobbering a good state with garbage.
      const ToState = typeof Payload.toState === 'string' && Payload.toState.length > 0 ? Payload.toState : null;
      if (ToState !== null) {
        ArgRecord.state = Object.prototype.hasOwnProperty.call(STATE_VOCABULARY, ToState)
          ? STATE_VOCABULARY[ToState]
          : ToState;
      }
      break;
    }

    default:
      // unreachable — unknown types are filtered before ApplyEvent
      break;
  }
  ArgRecord.isActive = IsActiveState(ArgRecord.state);
}

/**
 * Fold an Event[] into per-reminder records. Returns an ordered array of
 * records (insertion order = first-seen reminderId order), which is
 * deterministic for a given input. Unknown event types are skipped with a
 * warning. Events missing a `reminderId` are skipped with a warning.
 *
 * @param {Event[]} ArgEvents
 * @param {{ warn?: (msg: string) => void }} [ArgOpts]
 * @returns {ReminderRecord[]}
 */
function FoldReminders(ArgEvents, ArgOpts = {}) {
  const Warn = typeof ArgOpts.warn === 'function'
    ? ArgOpts.warn
    : (/** @type {string} */ ArgMsg) => { try { console.warn(ArgMsg); } catch { /* noop */ } };

  const Events = Array.isArray(ArgEvents) ? ArgEvents : [];
  /** @type {Map<string, ReminderRecord>} */
  const ById = new Map();
  /** @type {string[]} */
  const Order = [];

  for (const Event of Events) {
    if (!Event || typeof Event !== 'object') {
      Warn('[events-projection] skipping non-object event');
      continue;
    }
    if (!KNOWN_EVENT_TYPES.has(Event.type)) {
      Warn(`[events-projection] skipping unknown event type: ${String(Event.type)}`);
      continue;
    }
    // Known, but not reminder-scoped: dropped silently and BEFORE the record-creation below, so it
    // cannot mint a row keyed on a synthetic id. Silent because this is expected traffic in a v2
    // stream, not a forward-compatibility surprise.
    if (NON_REMINDER_EVENT_TYPES.has(Event.type)) {
      continue;
    }
    const ReminderId = Event.reminderId;
    if (typeof ReminderId !== 'string' || ReminderId.length === 0) {
      Warn(`[events-projection] skipping event with missing reminderId (type=${Event.type})`);
      continue;
    }
    let Record = ById.get(ReminderId);
    if (!Record) {
      Record = MakeReminderRecord(ReminderId);
      ById.set(ReminderId, Record);
      Order.push(ReminderId);
    }
    ApplyEvent(Record, Event);
  }

  return Order.map((ArgId) => ById.get(ArgId));
}

/**
 * Pure fold from an Event[] into the rebalance export envelope shape (the
 * `?format=rebalance` payload). Deterministic: same input → byte-identical
 * output. No I/O, no Slack/GitHub calls.
 *
 * Envelope mirrors web-api.js:528-548. Counts and `returnedReminderCount`
 * reflect the active-only view when `activeOnly` is requested.
 *
 * @param {Event[]} ArgEvents Events conforming to CONTRACT.md's event shape.
 * @param {{ workspace?: string, activeOnly?: boolean, states?: string[]|null, warn?: (msg: string) => void }} [ArgOpts]
 * @returns {Object} rebalanceExportObject
 */
function foldToRebalanceShape(ArgEvents, ArgOpts = {}) {
  const Workspace = typeof ArgOpts.workspace === 'string' ? ArgOpts.workspace : '';
  const ActiveOnly = Boolean(ArgOpts.activeOnly);
  const StateFilter = Array.isArray(ArgOpts.states) ? ArgOpts.states.slice() : [];

  const AllRecords = FoldReminders(ArgEvents, ArgOpts);
  const TotalReminderCount = AllRecords.length;

  let Selected = AllRecords;
  if (ActiveOnly) Selected = Selected.filter((ArgRecord) => ArgRecord.isActive);
  if (StateFilter.length > 0) {
    const Wanted = new Set(StateFilter);
    Selected = Selected.filter((ArgRecord) => Wanted.has(ArgRecord.state));
  }

  return {
    workspaceName: Workspace,
    totalReminderCount: TotalReminderCount,
    returnedReminderCount: Selected.length,
    filters: {
      activeOnly: ActiveOnly,
      states: StateFilter,
    },
    source: {
      type: 'sleuth-events-projection',
      relativePath: null,
    },
    reminders: Selected,
  };
}

/**
 * Fold to the list of currently-active reminders (scheduled or snoozed).
 * @param {Event[]} ArgEvents
 * @param {{ warn?: (msg: string) => void }} [ArgOpts]
 * @returns {ReminderRecord[]}
 */
function foldActive(ArgEvents, ArgOpts = {}) {
  return FoldReminders(ArgEvents, ArgOpts).filter((ArgRecord) => ArgRecord.isActive);
}

/**
 * Fold to completed reminders, optionally restricted to a [fromMs, toMs] window
 * (inclusive) over each record's `completedAt`. Records with an unparseable or
 * missing `completedAt` are excluded when a window is supplied.
 *
 * @param {Event[]} ArgEvents
 * @param {{ fromMs?: number, toMs?: number, warn?: (msg: string) => void }} [ArgOpts]
 * @returns {ReminderRecord[]}
 */
function foldCompleted(ArgEvents, ArgOpts = {}) {
  const HasWindow = ArgOpts.fromMs != null || ArgOpts.toMs != null;
  const FromMs = ArgOpts.fromMs != null ? ArgOpts.fromMs : -Infinity;
  const ToMs = ArgOpts.toMs != null ? ArgOpts.toMs : Infinity;

  return FoldReminders(ArgEvents, ArgOpts).filter((ArgRecord) => {
    if (ArgRecord.state !== 'completed') return false;
    if (!HasWindow) return true;
    const CompletedMs = Date.parse(ArgRecord.completedAt ?? '');
    if (!Number.isFinite(CompletedMs)) return false;
    return CompletedMs >= FromMs && CompletedMs <= ToMs;
  });
}

module.exports = {
  foldToRebalanceShape,
  foldActive,
  foldCompleted,
  FoldReminders,
  KNOWN_EVENT_TYPES,
};
