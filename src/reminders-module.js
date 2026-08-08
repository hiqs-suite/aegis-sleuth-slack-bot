// import required modules.
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const SlackApp = require('./slack-app');
const WorkspaceAI = require('./workspace-ai');
const DateUtils = require('./date-utils');
const RemindersChannelSettings = require('./reminders-channel-settings');
const RemindersAIPipeline = require('./reminders-ai-pipeline');
const RemindersReactionHandler = require('./reminders-reaction-handler');
const RemindersAppMentionHandler = require('./reminders-app-mention-handler');
const {
  GetAlphabeticalLabel,
  BuildCompactTextForReminder,
  PostBucketedReminderSectionsAsync,
} = require('./reminders-display-utils');
const { ExtractGitHubUrls } = require('./github-url-utils');
const { LoadClientMappingsSync, ResolveClientIdentity, GetClientDefaults, ResolveClientNameForReminder, ApplyClientPrefix } = require('./client-mapping');
const { BuildWorkspaceSnapshot } = require('./workspace-snapshot');
const { WriteFileDurableAsync, AppendFileDurableAsync, SweepStaleTempsAsync } = require('./durable-write');
const { FindRelatedOpenReminders, BuildRelatedFootnote } = require('./connection-surfacing');
const GitHubCommentRelay = require('./github-comment-relay');
const SlackFormatUtils = require('./slack-format-utils');
const CompletionStore = require('./completion-store');
const { createEventStore, CURRENT_SCHEMA_VERSION } = require('./event-store');
const { FoldReminderReadModels, ReadWithProjectionFallbackAsync } = require('./reminders-projection');

// add typedefs for OpenAI-defined types (just import them from workspace-ai.js to avoid duplication).
/**
 * @typedef {import('./workspace-ai').ResponseSchema} ResponseSchema
 */

/**
 * Information about a reminder extracted from a message by the GPT model.
 * @typedef {Object} GptReminderInfo
 * @property {string} actionable_language Verbatim quotation of the actionable language detected in the message.
 * @property {string} scheduling_trigger Verbatim quotation of the trigger associated with the actionable language.
 * @property {string} reminder_message Brief reminder of the actionable task that a user should perform.
 */

/**
 * Represents the response from the GPT model when analyzing a message for reminders.
 * @typedef {Object} GptReminderResponse
 * @property {'schedule' | 'ignore'} recommendation Indicates whether a reminder should be scheduled or ignored.
 * @property {string} rationale Explanation for the recommendation, used for debugging and informing users.
 * @property {GptReminderInfo[]} reminders Array of GptReminderInfo objects (empty if 'recommendation' is 'ignore').
 */

/**
 * Represents the components of a datetime and the rationale for how they were computed or extracted by the GPT.
 * @typedef {Object} GptDateExtractionResult
 * @property {number} year Extracted or computed year component of the date.
 * @property {number} month Extracted or computed month component of the date (1-based, i.e. January is 1).
 * @property {number} day Extracted or computed day component of the date.
 * @property {number} hour Extracted or computed hour component in 24-hour format.
 * @property {number} minute Extracted or computed minute component.
 * @property {number} second Extracted or computed second component.
 * @property {string} rationale Detailed explanation of how and why the extracted or computed values were arrived at.
 */

/**
 * Represents the result of extracting a date from a scheduling trigger using the GPT model.
 * @typedef {Object} DateExtractionResult
 * @property {boolean} success Was the date successfully extracted?
 * @property {Date|null} date Extracted date, or null if extraction failed.
 * @property {string} phrase Phrase that was used to extract the date.
 * @property {boolean} [wasAdjustedForward] True if the date was in the past and pushed forward.
 */

/**
 * Stores information about a reminder to be posted in the future.
 * @typedef  {Object}  ReminderInfo
 * @property {string}  ReminderID          UUID of the reminder.
 * @property {Date}    CreatedOn           Date and time the reminder was created.
 * @property {Date}    ShouldPostOn        Date and time when the reminder should be posted.
 * @property {string}  TargetChannelID     ID of the channel where the reminder will be posted.
 * @property {string}  OriginalChannelID   ID of the channel where the original message was posted.
 * @property {string|null} [OriginalChannelName] Name of the channel where the original message was posted (stored when accessible, backwards compatible).
 * @property {string}  OriginalMessageID   ID of the message that the reminder is for.
 * @property {string|null} [OriginalThreadTs] Root thread timestamp of the original message (null for top-level messages, backwards compatible).
 * @property {string}  OriginalSenderID    ID of the user who sent the original message.
 * @property {string}  ReminderMessageText Message to post when the reminder is due.
 * @property {boolean} IgnoreSnooze        Post on snoozed days when true.
 * @property {string|null} [AssigneeID]    Deprecated compatibility mirror of the first AssigneeIDs entry. Retained for older readers.
 * @property {string[]} [AssigneeIDs]      Authoritative ordered, de-duplicated human Slack user IDs assigned to this shared reminder.
 * @property {string[]|null} [GitHubUrls]  GitHub issue or PR URLs extracted from the original message (backwards compatible).
 * @property {boolean} [GitHubRelayStopped] When true, no further Slack thread messages will be relayed to linked GitHub issues (backwards compatible).
 * @property {boolean} [GitHubRelayStarted] When true, at least one message has already been relayed; the first relay includes the Slack thread permalink (backwards compatible).
 * @property {string|null} [clientId] Stable client slug (e.g. "client-a"), stamped at creation or resolved at read time. Null when unmatched (backwards compatible).
 * @property {string|null} [projectId] Project identifier — null in v1; reserved for a future phase (backwards compatible).
 * @property {'scheduled'|'due'|'overdue'|'snoozed'|'posting'|'posted'|'rescheduled'|'failed'|'completed'|'canceled'|'dead-letter'} [State]
 * Reminder lifecycle state. Managed exclusively via #TransitionReminderState() — never set directly.
 * Optional because legacy reminders may lack it; backfilled to 'scheduled' on load.
 * Legacy 'due' state is promoted to 'overdue' on load (backward compat).
 * See RemindersModule.ReminderState for valid transitions and FSM contract.
 */

class RemindersModule {
  /**
   * Reminder lifecycle state constants.
   *
   * FSM STATUS: State is the primary controller of reminder lifecycle. #CheckRemindersAsync runs two passes each
   * cycle: a mark pass (scheduled/failed → overdue, no Slack I/O) and a post pass (overdue → posting, with
   * auto-post threshold). Reminders overdue by more than 24 hours accumulate in 'overdue' and appear in the
   * "show my reminders" past-due buckets without flooding Slack on app restart.
   *
   * VALID TRANSITIONS (enforce when adding new code paths):
   *   scheduled  →  overdue            (mark pass: time-reached or force-process-all)
   *   failed     →  overdue            (mark pass: retry — always post-eligible regardless of age)
   *   overdue    →  posting            (post pass: within auto-post threshold or retry-eligible)
   *   overdue    →  snoozed            (post pass: snooze-day suppression)
   *   snoozed    →  scheduled          (after advancing ShouldPostOn to next non-snooze day)
   *   posting    →  posted | failed
   *   posted     →  rescheduled
   *   rescheduled→  scheduled          (waiting for next mark pass)
   *   scheduled  →  completed          (terminal: white_check_mark reaction — not persisted, reminder deleted)
   *   scheduled  →  canceled           (terminal: wastebasket reaction — not persisted, reminder deleted)
   *   overdue    →  completed          (terminal: white_check_mark reaction while overdue)
   *   overdue    →  canceled           (terminal: wastebasket reaction while overdue)
   *   posting    →  dead-letter        (terminal: bot not a channel member — not persisted, reminder deleted)
   *
   * LEGACY: 'due' is kept for backward compatibility. Reminders persisted in 'due' state are promoted to
   * 'overdue' on load. New code should never write 'due' state.
   *
   * IMPORTANT FOR LLMs AND DEVELOPERS:
   * - Always call #TransitionReminderState() when a reminder changes lifecycle stage. Never set .State directly.
   * - Always use RemindersModule.ReminderState constants. Never use raw string literals for state values.
   * - Terminal transitions (completed, canceled, dead-letter) are log-only; the reminder is deleted immediately after.
   * - If you add a new code path that changes reminder behavior, add a corresponding transition or this FSM will drift.
   */
  static ReminderState = Object.freeze({
    Scheduled: 'scheduled',
    Due: 'due',       // legacy — kept for backward compat; promoted to Overdue on load.
    Overdue: 'overdue',
    Snoozed: 'snoozed',
    Posting: 'posting',
    Posted: 'posted',
    Rescheduled: 'rescheduled',
    Failed: 'failed',
    Completed: 'completed',
    Canceled: 'canceled',
    DeadLetter: 'dead-letter',
  });

  /**
   * Slack app instance.
   * @type {SlackApp}
   */
  #SlackApp;

  /**
   * Workspace AI instance.
   * @type {WorkspaceAI}
   */
  #WorkspaceAI;

  /**
   * Channel settings manager for enable/disable per-channel reminders.
   * @type {RemindersChannelSettings}
   */
  #ChannelSettings;

  /**
   * AI pipeline for reminder analysis, date extraction, and deduplication.
   * @type {RemindersAIPipeline}
   */
  #AIPipeline;

  /**
   * Reaction handler for emoji-driven reminder lifecycle transitions.
   * @type {RemindersReactionHandler}
   */
  #ReactionHandler;

  /**
   * App mention handler for command execution and reminder queries.
   * @type {RemindersAppMentionHandler}
   */
  #AppMentionHandler;

  /**
   * GitHub comment relay for forwarding Slack thread replies to GitHub issues/PRs.
   * @type {GitHubCommentRelay}
   */
  #GitHubCommentRelay;

  /**
   * Path to the file where reminders are stored on disk.
   * @type {string}
   */
  #ReminderFilePath;

  /**
   * Sleuth-owned history of completed reminders, captured at the FSM chokepoint and read by the
   * weekly summary. Independent of Slack Lists. Created and loaded in StartAsync.
   * @type {CompletionStore|null}
   */
  #CompletionStore = null;

  /**
   * P3 Phase 1 (NON-authoritative): best-effort append-only lifecycle ledger. A side log that
   * mirrors FSM transitions AFTER the in-memory mutation — mutate-first still leads, the log may
   * lag or be lossy, and a log failure can NEVER block or fail a transition. Created in StartAsync;
   * null before then (and in unit tests that skip StartAsync), in which case emission is a no-op.
   * @type {ReturnType<typeof createEventStore>|null}
   */
  #EventStore = null;

  /**
   * Workspace key the event ledger appends under (the tenant's WORKSPACE_NAME). Captured in
   * StartAsync alongside #EventStore.
   * @type {string|null}
   */
  #EventWorkspace = null;

  /**
   * Path to the file where the reminder counter info is stored on disk.
   * @type {string}
   */
  #ReminderCounterFilePath;

  /**
   * Path to the JSONL file where false-positive training examples are appended.
   * @type {string}
   */
  #TrashedExamplesFilePath;

  /**
   * Path to the cursor file that tracks how many JSONL lines were processed by the last weekly report.
   * @type {string}
   */
  #TrashedExamplesCursorFilePath;

  /**
   * Timer ID for the weekly false-positive report scheduler.
   * @type {NodeJS.Timeout|null}
   */
  #WeeklyReportTimerID = null;

  /**
   * Timer ID for daily task digest scheduling.
   * @type {NodeJS.Timeout|null}
   */
  #DailyDigestTimerID = null;

  /**
   * Date string (YYYY-MM-DD) of the last daily digest sent in workspace timezone.
   * Used to prevent duplicate digests on the same day.
   * @type {string|null}
   */
  #LastDailyDigestDate = null;

  /**
   * Interval in milliseconds at which to check for pending reminders.
   * @type {number}
   */
  #ReminderCheckInterval = 30000; // 30 seconds.

  /**
   * Set of lowercase day names when reminders should not be posted.
   * @type {Set<string>}
   */
  #SnoozeDays = new Set();

  /**
   * Queue of pending reminders. This is saved to disk and reloaded when the app restarts.
   * @type {ReminderInfo[]}
   */
  #PendingRemindersQueue = [];

  /**
   * Map of reminders keyed by the original sender for quick lookup.
   * @type {Map<string, ReminderInfo[]>}
   */
  #RemindersBySender = new Map();

  /**
   * Map of reminders keyed by AssigneeID for O(1) "show my reminders" lookups.
   * @type {Map<string, ReminderInfo[]>}
   */
  #RemindersByAssignee = new Map();

  /**
   * Counter used to generate reminder numbers to help identify them in a channel when they are posted simultaneously.
   *
   * This counter is incremented each time a reminder is posted and is reset so it begins anew each day. The idea behind
   * the number is to help users keep track of progress when triaging reminders in a channel. For example, a user can say
   * "I have reviewed reminders 1 to 3, and I will review the rest later".
   * @type {number}
   */
  #ReminderCounter;

  /**
   * Date and time when the reminder counter was last reset. This is used to reset the counter every day.
   * @type {Date}
   */
  #ReminderCounterLastReset;

  /**
   * Timer ID for the reminder check interval. This is used to clear the timer when the app is stopped.
   * @type {NodeJS.Timeout}
   */
  #ReminderTimerID;

  /**
   * Cached ID of the channel where reminders will be posted by default.
   * @type {string|null}
   */
  #ReminderChannelID = null;

  /**
   * Proactive digest settings — per-workspace kill switch and per-signal toggles.
   * Loaded from WorkspaceInfo at digest time (settings-module pattern: read from workspace JSON).
   * WorkspaceInfo keys:
   *   PROACTIVE_DIGEST_ENABLED        — 'false' to kill the whole section (default: on)
   *   PROACTIVE_DIGEST_GONE_QUIET     — 'false' to disable gone-quiet signal (default: on)
   *   PROACTIVE_DIGEST_DEADLINE       — 'false' to disable deadline-collision signal (default: on)
   *   PROACTIVE_DIGEST_AGING          — 'false' to disable aging-without-owner signal (default: on)
   * @returns {{ enabled: boolean, goneQuiet: boolean, deadlineCollision: boolean, agingWithoutOwner: boolean }}
   */
  #GetProactiveDigestSettings() {
    const W = this.#SlackApp.WorkspaceInfo;
    const IsFalse = (/** @type {string|undefined} */ ArgVal) =>
      typeof ArgVal === 'string' && ArgVal.trim().toLowerCase() === 'false';
    return {
      enabled: !IsFalse(W.PROACTIVE_DIGEST_ENABLED),
      goneQuiet: !IsFalse(W.PROACTIVE_DIGEST_GONE_QUIET),
      deadlineCollision: !IsFalse(W.PROACTIVE_DIGEST_DEADLINE),
      agingWithoutOwner: !IsFalse(W.PROACTIVE_DIGEST_AGING),
    };
  }

  /**
   * Indicates if reminders data was successfully loaded from disk.
   * @type {boolean}
   */
  #DataLoaded = false;

  /**
   * Error message when reminder data fails to load.
   * @type {string|null}
   */
  #DataLoadError = null;

  /**
   * Serializes reminder-queue writes so two concurrent saves cannot lose an update.
   *
   * Atomic rename (GH-12) makes each save all-or-nothing, but it does not ORDER saves. Without this
   * chain: writer A snapshots #PendingRemindersQueue, writer B snapshots it, B renames, then A
   * renames its now-stale snapshot on top — and B's change is silently gone, leaving a perfectly
   * valid JSON file. #SaveRemindersAsync serializes the whole snapshot-then-write pair, so a save
   * always serializes the queue as it stands after the previous save landed.
   *
   * This is reachable in normal operation, not just in theory: the save callback handed to
   * GitHubCommentRelay in the constructor is invoked without being awaited, so a relay-driven save
   * can overlap an in-flight one from any of the other call sites.
   *
   * Mirrors the #WriteChain idiom already proven in src/completion-store.js.
   * @type {Promise<void>}
   */
  #SaveChain = Promise.resolve();

  /**
   * Lists module instance for Slack Lists integration.
   * @type {import('./lists-module')|null}
   */
  #ListsModule = null;

  /**
   * GitHub sync module instance for debug/testing hooks.
   * @type {import('./github-sync-module')|null}
   */
  #GitHubSyncModule = null;

  /**
   * Cached per-workspace routing snapshot (GH-405). Null until first built; lazily built on the first
   * GetWorkspaceSnapshot() call and invalidated at the single lifecycle chokepoint
   * (#EmitLifecycleEvent), so routing never pays a per-mention recompute. Held on the (already
   * per-workspace) instance — NEVER a module global — so one tenant's snapshot cannot leak across
   * workspaces (#387 isolation guard).
   * @type {import('./workspace-snapshot').WorkspaceSnapshot|null}
   */
  #WorkspaceSnapshot = null;

  /**
   * Initialize a new instance of the RemindersModule with the given Slack app.
   * @param {SlackApp} ArgSlackApp Slack app instance.
   */
  constructor(ArgSlackApp) {
    // save the Slack app instance.
    this.#SlackApp = ArgSlackApp;

    this.#AppMentionHandler = new RemindersAppMentionHandler({
      GetPendingReminders: () => this.#PendingRemindersQueue,
      GetRemindersTargetingUserID: (/** @type {string} */ ArgUserID) => this.#GetRemindersTargetingUserID(ArgUserID),
      GetRemindersInvolvingUserID: (/** @type {string} */ ArgUserID) => this.#GetRemindersInvolvingUserID(ArgUserID),
      GetGitHubSyncModule: () => this.#GitHubSyncModule,
      GetListsModule: () => this.#ListsModule,
      GetChannelSettings: () => this.#ChannelSettings,
      // Sleuth-owned completion history for the weekly summary — independent of Slack Lists.
      GetCompletedRemindersBetween: (/** @type {number} */ ArgStartMs, /** @type {number} */ ArgEndMs) =>
        this.GetCompletedRemindersBetween(ArgStartMs, ArgEndMs),
      // P3 Phase 2 (staged cutover, default OFF): expose the non-authoritative event ledger so the
      // weekly summary can optionally derive completions from the projection instead of the store.
      ReadAllEventsAsync: () => this.ReadAllEventsAsync(),
      // FSM gateway — injected so RemindersAppMentionHandler can schedule without a circular import.
      // Do not replace this with a direct #QueueReminderAsync call; that bypasses AI analysis,
      // dedup, date extraction, channel resolution, and #MakeScheduledReminder invariants.
      TryScheduleRemindersAsync: (
        /** @type {any} */ ArgSlackApp,
        /** @type {any} */ ArgText,
        /** @type {any} */ ArgChannelID,
        /** @type {any} */ ArgMessageID,
        /** @type {any} */ ArgUserID,
        /** @type {any} */ ArgForceSchedule,
        /** @type {any} */ ArgThreadTS,
        /** @type {any} */ ArgLiveReplyText,
        /** @type {any} */ ArgUsedEnrichedThreadContext
      ) =>
        this.#TryScheduleRemindersAsync(
          ArgSlackApp,
          ArgText,
          ArgChannelID,
          ArgMessageID,
          ArgUserID,
          ArgForceSchedule,
          ArgThreadTS,
          ArgLiveReplyText,
          ArgUsedEnrichedThreadContext
        ),
      CheckRemindersAsync: (/** @type {any} */ ArgIgnoreSnooze) => this.#CheckRemindersAsync(ArgIgnoreSnooze),
    });

    // instantiate the GitHub comment relay for forwarding thread replies to GitHub.
    this.#GitHubCommentRelay = new GitHubCommentRelay(
      this.#SlackApp,
      () => this.#PendingRemindersQueue,
      () => this.#SaveRemindersAsync(),
      // Ledger hook. The relay owns the only path that mutates GitHubRelayStarted/Stopped, so this
      // is the one place a thread's relay state can change after creation.
      (ArgThreadKey, ArgState) => this.#EmitThreadRelayStateChanged(ArgThreadKey, ArgState)
    );

    // add handlers for message and app mention events.
    // GitHub comment relay is registered first so thread replies are checked before reminder scheduling,
    // but it always returns false so the reminders handler still runs.
    this.#SlackApp.HandleMessage(this.#GitHubCommentRelay.OnMessageAsync.bind(this.#GitHubCommentRelay));
    this.#SlackApp.HandleMessage(this.#OnMessageAsync.bind(this));
    this.#SlackApp.HandleAppMention(this.#AppMentionHandler.OnAppMentionAsync.bind(this.#AppMentionHandler));
  }

  /**
   * Transition reminder state with a trace log.
   *
   * This is the ONLY method that should set .State on a reminder. All state changes must go through here
   * so that transitions are logged consistently and the FSM audit trail is maintained. See ReminderState
   * for the valid transition graph. Prefix ArgReason with "terminal:" for states where the reminder is
   * about to be deleted (completed, canceled, dead-letter).
   *
   * @param {ReminderInfo} ArgReminder Reminder to transition.
   * @param {ReminderInfo['State']} ArgNextState Next reminder state.
   * @param {string} ArgReason Reason for transition (prefix with "terminal:" if reminder will be deleted after).
   */
  #TransitionReminderState(ArgReminder, ArgNextState, ArgReason) {
    const PreviousState = ArgReminder.State ?? RemindersModule.ReminderState.Scheduled;
    ArgReminder.State = ArgNextState;
    this.#SlackApp.Logger.info(
      `[reminder-state] ${ArgReminder.ReminderID} ${PreviousState} -> ${ArgNextState} (${ArgReason})`
    );

    // Every completion path (✅ reaction, list checkbox, chat command, github-sync) funnels through
    // this single transition, so capturing here records 100% of completions to Sleuth's own history.
    // Sample the completion instant ONCE and share it with BOTH the authoritative CompletionRecord
    // and the ledger event. Previously each sampled its own Date.now(), so the stored and projected
    // completedMs were two different clock reads and could never be byte-identical — which is why
    // COMPLETED_READ_SOURCE had to be blocked. Codex confirmed this does not breach the FSM
    // contract: validate-fsm-invariants governs state assignment and construction bypasses.
    let CompletedMs = null;
    if(ArgNextState === RemindersModule.ReminderState.Completed) {
      CompletedMs = Date.now();
      this.#RecordCompletion(ArgReminder, CompletedMs);
    }

    // P3 Phase 1 (NON-authoritative): mirror the lifecycle change into the append-only event
    // ledger. Emitted AFTER the in-memory mutation above (mutate-first leads). Best-effort and
    // fire-and-forget — append() is async, never rejects, and a log failure cannot block or fail
    // this transition. Keeps #TransitionReminderState synchronous, exactly like #RecordCompletion.
    this.#EmitTransitionEvent(ArgReminder, ArgNextState, ArgReason, CompletedMs, PreviousState);
  }

  /**
   * Translate an FSM transition into a Phase 1 lifecycle event and emit it (best-effort). Only the
   * subset of states present in the Phase 1 event enum is mapped; other states (due, overdue,
   * posting, posted, rescheduled, failed, dead-letter) are intentionally not emitted yet.
   * @param {ReminderInfo} ArgReminder
   * @param {string} ArgNextState
   * @param {string} ArgReason
   * @param {number|null} [ArgCompletedMs] Completion instant sampled once by the caller and shared
   *   with the authoritative CompletionRecord, so the stored and projected values are one number.
   * @param {string|null} [ArgPreviousState] State before the transition, for the generic
   *   ReminderStateChanged event.
   */
  #EmitTransitionEvent(ArgReminder, ArgNextState, ArgReason, ArgCompletedMs = null, ArgPreviousState = null) {
    const State = RemindersModule.ReminderState;
    const DueAtIso = ArgReminder.ShouldPostOn ? new Date(ArgReminder.ShouldPostOn).toISOString() : null;
    switch(ArgNextState) {
      case State.Scheduled:
        this.#EmitLifecycleEvent('ReminderScheduled', ArgReminder, { dueAt: DueAtIso, via: ArgReason || null });
        break;
      case State.Completed: {
        // completedMs is sampled ONCE here and shared with the authoritative CompletionRecord, so
        // the projected and stored values are the same number rather than two clock reads that can
        // never be byte-identical. Codex confirmed in consult that this does not breach the FSM
        // contract: validate-fsm-invariants governs state assignment and construction bypasses, not
        // timestamp provenance.
        const CompletedMs = typeof ArgCompletedMs === 'number' ? ArgCompletedMs : Date.now();
        this.#EmitLifecycleEvent('ReminderCompleted', ArgReminder, {
          by: ArgReminder.AssigneeID || null,
          method: ArgReason || 'fsm',
          summary: ArgReminder.ReminderMessageText || null,
          completedAt: new Date(CompletedMs).toISOString(),
          completedMs: CompletedMs,
          sourceChannelId: ArgReminder.OriginalChannelID || ArgReminder.TargetChannelID || null,
          dueDate: DueAtIso,
          clientId: ArgReminder.clientId ?? null,
        });
        break;
      }
      case State.Snoozed:
        this.#EmitLifecycleEvent('ReminderSnoozed', ArgReminder, { until: DueAtIso, by: ArgReminder.AssigneeID || null });
        break;
      case State.Canceled:
        this.#EmitLifecycleEvent('ReminderCancelled', ArgReminder, { by: ArgReminder.AssigneeID || null, reason: ArgReason || null });
        break;
      default:
        break;
    }

    // v2: a GENERIC transition event for every state change, including the seven this switch
    // deliberately skipped (due, overdue, posting, posted, rescheduled, failed, dead-letter).
    // Without it a fold silently retained `scheduled` for a reminder that had actually gone
    // overdue — and production persists at least `overdue` when no posting occurs
    // (#CheckRemindersAsync), so this was never theoretical. Emitted IN ADDITION to the specific
    // events above so existing folds are unaffected.
    this.#EmitLifecycleEvent('ReminderStateChanged', ArgReminder, {
      fromState: ArgPreviousState,
      toState: ArgNextState,
      reason: ArgReason || null,
    });
  }

  /**
   * Best-effort append of one lifecycle event to the NON-authoritative ledger. No-op before the
   * store is initialized (unit tests that skip StartAsync). Fire-and-forget: the async append is
   * never awaited so the FSM hot path stays synchronous, and the call site can never throw —
   * append() resolves `{ ok:false }` on failure rather than rejecting, and a defensive try/catch +
   * rejection handler guarantee nothing surfaces onto the transition.
   * @param {string} ArgType One of the Phase 1 event enum types.
   * @param {ReminderInfo} ArgReminder
   * @param {object} ArgPayload Fully-formed payload for ArgType (all required keys present).
   */
  #EmitLifecycleEvent(ArgType, ArgReminder, ArgPayload) {
    // GH-405: every create/complete/schedule/snooze/cancel routes through here, so invalidating the
    // cached routing snapshot here covers them all with one hook. Done BEFORE the event-store guard
    // below so the cache is invalidated even in unit tests that skip StartAsync (no event store).
    // Lazy rebuild happens on the next GetWorkspaceSnapshot() call — no work on the FSM hot path.
    this.#WorkspaceSnapshot = null;

    this.#AppendLedgerEvent(ArgType, ArgReminder.ReminderID, ArgPayload);
  }

  /**
   * Append one thread-scoped relay-state event. Separate from #EmitLifecycleEvent because relay
   * state belongs to a THREAD, not a reminder: one Slack thread can carry several reminders, and a
   * new one can join a thread that is already relaying. The envelope still needs a `reminderId`, so
   * this carries the synthetic `thread:<key>` rather than naming an arbitrary member — see
   * src/event-store.js for why. Does NOT invalidate the routing snapshot: relay state is not an
   * input to mention routing.
   * @param {string} ArgThreadKey `OriginalThreadTs ?? OriginalMessageID` for the thread (GH-27).
   * @param {{ relayStarted: boolean, relayStopped: boolean }} ArgState Resulting thread state.
   */
  #EmitThreadRelayStateChanged(ArgThreadKey, ArgState) {
    if(typeof ArgThreadKey !== 'string' || ArgThreadKey.length === 0) return;
    this.#AppendLedgerEvent('ThreadRelayStateChanged', `thread:${ArgThreadKey}`, {
      threadKey: ArgThreadKey,
      relayStarted: Boolean(ArgState && ArgState.relayStarted),
      relayStopped: Boolean(ArgState && ArgState.relayStopped),
    });
  }

  /**
   * The low-level, best-effort ledger append shared by every emitter. No-op before the store is
   * initialized. Fire-and-forget and non-throwing, per the contract described on #EmitLifecycleEvent.
   * @param {string} ArgType One of the closed event-enum types.
   * @param {string} ArgReminderId Envelope id — a real ReminderID, or a synthetic scope key.
   * @param {object} ArgPayload Fully-formed payload for ArgType.
   */
  #AppendLedgerEvent(ArgType, ArgReminderId, ArgPayload) {
    if(!this.#EventStore || !this.#EventWorkspace) {
      return;
    }
    try {
      this.#EventStore.append(this.#EventWorkspace, {
        // Stamp the current schema version so the append is validated against the WIDER v2
        // requirement set. Historical v1 events keep reading unchanged — the version gate lives in
        // NormalizeEvent, which treats a missing `v` as v1.
        v: CURRENT_SCHEMA_VERSION,
        type: ArgType,
        reminderId: ArgReminderId,
        payload: ArgPayload,
      }).then(
        (ArgResult) => {
          if(ArgResult && ArgResult.ok === false) {
            this.#SlackApp.Logger.warn(
              `[event-ledger] append failed (non-fatal): ${ArgType} ${ArgReminderId}`,
              ArgResult.error
            );
          }
        },
        (ArgError) => {
          this.#SlackApp.Logger.warn(`[event-ledger] append rejected (non-fatal): ${ArgType}`, ArgError);
        }
      );
    } catch(error) {
      this.#SlackApp.Logger.warn(`[event-ledger] emit threw (non-fatal): ${ArgType}`, error);
    }
  }

  /**
   * Append the just-completed reminder to Sleuth's own completion history. Fire-and-forget: the
   * store updates in memory synchronously and persists asynchronously, so this stays off the FSM's
   * hot path and never makes #TransitionReminderState async. No-op before the store is initialized
   * (e.g. unit tests that exercise the FSM without StartAsync).
   * @param {ReminderInfo} ArgReminder
   */
  #RecordCompletion(ArgReminder, /** @type {number|undefined} */ ArgCompletedMs) {
    if(!this.#CompletionStore) {
      return;
    }
    this.#CompletionStore.Record({
      reminderId: ArgReminder.ReminderID,
      summary: ArgReminder.ReminderMessageText || null,
      assigneeID: ArgReminder.AssigneeID || null,
      sourceChannelID: ArgReminder.OriginalChannelID || ArgReminder.TargetChannelID || null,
      dueDate: ArgReminder.ShouldPostOn ? new Date(ArgReminder.ShouldPostOn).toISOString() : null,
      // Shared with the ledger event rather than re-sampled — see #TransitionReminderState.
      completedMs: typeof ArgCompletedMs === 'number' ? ArgCompletedMs : Date.now(),
      clientId: ArgReminder.clientId || null,
    });
  }

  /**
   * Single factory for all new ReminderInfo objects. Owns the FSM entry-point invariants so no
   * creation site can forget them: ReminderID, CreatedOn, the initial State (Scheduled), and
   * IgnoreSnooze (false = obey weekend snooze policy on first run). Caller supplies every other field.
   *
   * INVARIANT ORDER: ArgFields spreads FIRST so the four FSM invariants always win — a caller that
   * accidentally passes State or IgnoreSnooze in the fields object cannot override them.
   *
   * DO NOT call #QueueReminderAsync with a manually-constructed object. Always go through this factory.
   * DO NOT add a new reminder creation path that bypasses this method — the FSM audit trail depends on
   * every live reminder entering life as State=Scheduled with IgnoreSnooze=false.
   *
   * @param {Partial<ReminderInfo>} ArgFields Caller-specific fields to merge in.
   * @returns {ReminderInfo}
   */
  #MakeScheduledReminder(ArgFields) {
    const Reminder = /** @type {ReminderInfo} */({
      ...ArgFields,
      // Invariants last — these cannot be overridden by the caller.
      ReminderID: crypto.randomUUID(),
      CreatedOn: new Date(),
      IgnoreSnooze: false,
      State: RemindersModule.ReminderState.Scheduled,
    });

    // Keep newly-written records forward- and rollback-compatible: AssigneeIDs is authoritative,
    // while AssigneeID remains the first value for binaries that predate shared assignments.
    this.#NormalizeReminderAssignees(Reminder);

    // Phase A (identity stamping): resolve client identity at creation time and stamp it onto the
    // live reminder object. clientId: null when no client matches — callers rely on this being a
    // clean null rather than undefined.
    const { ClientID, ProjectID } = ResolveClientIdentity(Reminder);
    Reminder.clientId = ClientID;
    Reminder.projectId = ProjectID;

    // P3 Phase 1 (NON-authoritative): every new reminder is born through this single factory, so
    // emitting ReminderCreated here captures 100% of creations with no parallel path. Best-effort
    // and fire-and-forget (see #EmitLifecycleEvent); reconstruction-from-disk does NOT go through
    // this factory, so reloads don't re-emit.
    this.#EmitLifecycleEvent('ReminderCreated', Reminder, {
      text: Reminder.ReminderMessageText || null,
      assigneeId: Reminder.AssigneeID || null,
      assigneeIds: Reminder.AssigneeIDs,
      sourceChannelId: Reminder.OriginalChannelID || Reminder.TargetChannelID || null,
      targetChannelId: Reminder.TargetChannelID || null,
      source: 'fsm',
      githubUrls: Array.isArray(Reminder.GitHubUrls) ? Reminder.GitHubUrls : [],
      clientId: Reminder.clientId,
      projectId: Reminder.projectId,
      // Phase 5 read cutover: these legacy-shape fields make a native creation event
      // lossless. Older events lack them and deliberately make the projection fall
      // back to the authoritative JSON file.
      createdOn: new Date(Reminder.CreatedOn).toISOString(),
      originalSenderId: Reminder.OriginalSenderID || null,
      originalMessageId: Reminder.OriginalMessageID || null,
      originalThreadTs: Reminder.OriginalThreadTs || null,
      originalChannelName: Reminder.OriginalChannelName || null,
      ignoreSnooze: Boolean(Reminder.IgnoreSnooze),
      // Relay state's starting value. Always false for a native creation — a reminder that has
      // never existed cannot have relayed — but written as a fact rather than left to a default,
      // because `undefined` reads as "not stopped" and would resume a relay a user had stopped.
      // Every later change arrives as a thread-scoped ThreadRelayStateChanged.
      gitHubRelayStarted: Boolean(Reminder.GitHubRelayStarted),
      gitHubRelayStopped: Boolean(Reminder.GitHubRelayStopped),
    });

    // A reminder is BORN State=Scheduled (the factory sets it; there is no transition INTO Scheduled
    // to fire #EmitTransitionEvent). Without a paired ReminderScheduled, a projection that derives
    // shouldPostOn/scheduled-state from ReminderScheduled would replay a new reminder with no due
    // date until a later reschedule. So emit it here once ShouldPostOn is known (both creation call
    // sites pass it into the factory). via:'created' distinguishes the birth schedule from a later
    // FSM reschedule (via:<reason>).
    if(Reminder.ShouldPostOn) {
      this.#EmitLifecycleEvent('ReminderScheduled', Reminder, {
        dueAt: new Date(Reminder.ShouldPostOn).toISOString(),
        via: 'created',
        // v2: scheduling RESETS IgnoreSnooze in the live queue, so a fold that does not replay it
        // keeps a stale value — which the rebalance export then publishes to an external consumer.
        ignoreSnooze: Boolean(Reminder.IgnoreSnooze),
      });
    }

    return Reminder;
  }

  /**
   * Return a reminder's canonical set of human assignees without mutating the record.
   * A non-empty AssigneeIDs array is authoritative; legacy records fall back to AssigneeID, then
   * OriginalSenderID. Invalid values, duplicates, and the bot are excluded.
   * @param {Partial<ReminderInfo>|null|undefined} ArgReminder Reminder record to inspect.
   * @param {string|null|undefined} [ArgBotUserID] Workspace bot ID to exclude.
   * @returns {string[]}
   */
  static GetAssigneeIDs(ArgReminder, ArgBotUserID = null) {
    if(!ArgReminder || typeof ArgReminder !== 'object') return [];

    const HasArray = Array.isArray(ArgReminder.AssigneeIDs);
    const Candidates = HasArray
      ? ArgReminder.AssigneeIDs
      : [ArgReminder.AssigneeID];
    /** @type {string[]} */
    const AssigneeIDs = [];
    for(const Candidate of Candidates) {
      if(typeof Candidate !== 'string') continue;
      const AssigneeID = Candidate.trim();
      if(!AssigneeID || AssigneeID === ArgBotUserID || AssigneeIDs.includes(AssigneeID)) continue;
      AssigneeIDs.push(AssigneeID);
    }

    if(AssigneeIDs.length > 0) return AssigneeIDs;

    const SenderID = typeof ArgReminder.OriginalSenderID === 'string'
      ? ArgReminder.OriginalSenderID.trim()
      : '';
    return SenderID && SenderID !== ArgBotUserID ? [SenderID] : [];
  }

  /**
   * Check whether a user belongs to a reminder's canonical assignee set.
   * @param {Partial<ReminderInfo>|null|undefined} ArgReminder Reminder record to inspect.
   * @param {string} ArgUserID Slack user ID to look up.
   * @param {string|null|undefined} [ArgBotUserID] Workspace bot ID to exclude.
   * @returns {boolean}
   */
  static IsAssignedTo(ArgReminder, ArgUserID, ArgBotUserID = null) {
    return RemindersModule.GetAssigneeIDs(ArgReminder, ArgBotUserID).includes(ArgUserID);
  }

  /**
   * Normalize one persisted reminder in-place and report whether its serialized assignee fields
   * changed. This is the single compatibility boundary for legacy AssigneeID-only records.
   * @param {ReminderInfo} ArgReminder Reminder record to normalize.
   * @returns {boolean}
   */
  #NormalizeReminderAssignees(ArgReminder) {
    const AssigneeIDs = RemindersModule.GetAssigneeIDs(ArgReminder, this.#SlackApp.BotUserID);
    const ArrayChanged = !Array.isArray(ArgReminder.AssigneeIDs)
      || ArgReminder.AssigneeIDs.length !== AssigneeIDs.length
      || ArgReminder.AssigneeIDs.some((ArgID, ArgIndex) => ArgID !== AssigneeIDs[ArgIndex]);
    const AssigneeID = AssigneeIDs[0] ?? null;
    const MirrorChanged = ArgReminder.AssigneeID !== AssigneeID;
    if(ArrayChanged) ArgReminder.AssigneeIDs = AssigneeIDs;
    if(MirrorChanged) ArgReminder.AssigneeID = AssigneeID;
    return ArrayChanged || MirrorChanged;
  }

  /**
   * Was reminder data loaded successfully?
   * @returns {boolean}
   */
  get DataLoaded() { return this.#DataLoaded; }

  /**
   * If DataLoaded is false this contains a short reason.
   * @returns {string|null}
   */
  get DataLoadError() { return this.#DataLoadError; }

  /**
   * Get the WorkspaceAI instance for this module.
   * @returns {import('./workspace-ai')}
   */
  get WorkspaceAI() { return this.#WorkspaceAI; }

  /**
   * Get the Slack app instance.
   * @returns {SlackApp}
   */
  get SlackApp() { return this.#SlackApp; }

  /**
   * Get all pending reminders from the system.
   * @returns {ReminderInfo[]} Array of all reminders.
   */
  GetAllReminders() {
    const AllReminders = [];
    for(const Reminders of this.#RemindersBySender.values()) {
      AllReminders.push(...Reminders);
    }
    return AllReminders;
  }

  /**
   * Rebuild the cached routing snapshot (GH-405) from live authoritative reminders. Deterministic and
   * fully in-memory: no LLM, no Slack, no I/O beyond the already-cached base client map. Open-state
   * filtering is delegated to BuildWorkspaceSnapshot (which uses OPEN_REMINDER_STATES as the single
   * source of truth), so this just hands it GetAllReminders(). Client display names resolve slug→name
   * through the same base client map that stamped each reminder's clientId (see #MakeScheduledReminder /
   * ResolveClientIdentity), so a bucketed name always matches the stamped identity.
   * @returns {void}
   */
  #RebuildWorkspaceSnapshot() {
    const Clients = LoadClientMappingsSync();
    this.#WorkspaceSnapshot = BuildWorkspaceSnapshot({
      activeReminders: this.GetAllReminders(),
      resolveClientName: (/** @type {string} */ ArgClientId) => {
        const Match = Clients.find(
          (/** @type {any} */ ArgClient) => ArgClient.ClientID === ArgClientId
        );
        return Match && typeof Match.ClientName === 'string' && Match.ClientName.length > 0
          ? Match.ClientName
          : null;
      },
    });
  }

  /**
   * Public accessor for the cached per-workspace routing snapshot (GH-405). Lazily builds on first
   * access (or after a lifecycle-event invalidation) so a freshly-loaded module always returns a valid
   * snapshot without a per-mention recompute. Never null.
   * @returns {import('./workspace-snapshot').WorkspaceSnapshot}
   */
  GetWorkspaceSnapshot() {
    if(!this.#WorkspaceSnapshot) {
      this.#RebuildWorkspaceSnapshot();
    }
    return /** @type {import('./workspace-snapshot').WorkspaceSnapshot} */ (this.#WorkspaceSnapshot);
  }

  /**
   * Build the connection-surfacing footnote for a freshly-created set of reminders: related open
   * reminders (rule-based, in-memory) plus, when GOOGLE_API_KEY is configured, related remembered
   * threads (semantic). Returns '' when there is nothing to surface. Never throws meaningfully — the
   * caller treats it as best-effort.
   * @param {ReminderInfo[]} ArgNewReminders
   * @returns {Promise<string>}
   */
  async #BuildConnectionFootnoteAsync(ArgNewReminders) {
    const OpenStates = new Set(['scheduled', 'due', 'overdue', 'snoozed']);
    const OpenReminders = this.GetAllReminders().filter(ArgReminder => OpenStates.has(ArgReminder.State));
    const RelatedItems = FindRelatedOpenReminders(ArgNewReminders, OpenReminders, LoadClientMappingsSync());

    // semantic pass — related remembered threads, gated behind GOOGLE_API_KEY. Skipped silently when
    // unset. Lazy-required so the thread-memory store is only touched when the feature is in use.
    // TODO: also run cosine similarity against open reminders once embedding infra is proven.
    let MemoryCount = 0;
    if(process.env.GOOGLE_API_KEY) {
      try {
        const { GetThreadMemoryDb, FindRelatedMemories } = require('./thread-memory');
        /** @type {string[]} */
        const NewUrls = [];
        for(const Reminder of ArgNewReminders)
          for(const Url of Array.isArray(Reminder.GitHubUrls) ? Reminder.GitHubUrls : [])
            if(!NewUrls.includes(Url)) NewUrls.push(Url);
        if(NewUrls.length > 0) {
          const Memories = FindRelatedMemories(GetThreadMemoryDb(), this.#SlackApp.TeamId || 'unknown', NewUrls);
          MemoryCount = Memories.length;
        }
      } catch(error) {
        this.#SlackApp.Logger.warn('connection surfacing: related-memory lookup failed (non-fatal):', error);
      }
    }

    // Resolve the client label for the creation footnote. Use the first new reminder that matches
    // a client; if none match, the label is '' and BuildRelatedFootnote omits the "Client:" prefix.
    let ClientLabel = '';
    const AllClients = LoadClientMappingsSync();
    for(const NewReminder of ArgNewReminders) {
      const { ClientID } = ResolveClientIdentity(NewReminder);
      if(ClientID) {
        const MatchedClient = AllClients.find(
          (/** @type {any} */ ArgClient) => ArgClient.ClientID === ClientID
        );
        if(MatchedClient && typeof MatchedClient.ClientName === 'string')
          ClientLabel = MatchedClient.ClientName;
        break;
      }
    }

    return BuildRelatedFootnote(RelatedItems, MemoryCount, ClientLabel);
  }

  /**
   * Completed reminders from Sleuth's own history whose completion time falls in
   * [ArgStartMs, ArgEndMs), oldest-first. Powers the weekly summary and is independent of Slack
   * Lists. Reads in-memory state, so it reflects a completion synchronously after it is recorded.
   * @param {number} ArgStartMs Inclusive lower bound (epoch ms).
   * @param {number} ArgEndMs Exclusive upper bound (epoch ms).
   * @returns {Array<{reminderId: string, summary: string|null, assigneeID: string|null, sourceChannelID: string|null, dueDate: string|null, completedMs: number}>}
   */
  GetCompletedRemindersBetween(ArgStartMs, ArgEndMs) {
    return this.#CompletionStore ? this.#CompletionStore.GetCompletedBetween(ArgStartMs, ArgEndMs) : [];
  }

  /**
   * Read all NON-authoritative lifecycle events for this workspace from the append-only ledger.
   * Returns [] before the store is initialized or when the workspace has no events yet. Backs the
   * staged summarize-week projection cutover (default OFF) so the weekly summary can derive
   * completions from the event log for shadow comparison against the authoritative CompletionStore.
   * @returns {Promise<Array<object>>}
   */
  async ReadAllEventsAsync() {
    if(!this.#EventStore || !this.#EventWorkspace) return [];
    return this.#EventStore.readAll(this.#EventWorkspace);
  }

  /**
   * Complete a reminder by ID using the same path as the white check mark reaction.
   * @param {string} ArgReminderID Reminder ID to complete.
   * @param {string} ArgReason Reason for completion.
   * @returns {Promise<boolean>}
   */
  async CompleteReminderByIdAsync(ArgReminderID, ArgReason) {
    const ReminderToComplete = this.#PendingRemindersQueue.find(ArgReminder => ArgReminder.ReminderID === ArgReminderID);
    if(!ReminderToComplete) {
      this.#SlackApp.Logger.warn(`[github-sync] reminder ${ArgReminderID} not found for completion`);
      return false;
    }

    this.#TransitionReminderState(ReminderToComplete, RemindersModule.ReminderState.Completed, ArgReason);
    // 'completed' routes through ListsModule.HandleReminderCompletedAsync, which marks the
    // row done in every list and keeps it on per-user lists as a history record.
    await this.#DeleteRemindersAsync([ArgReminderID], 'completed');
    this.#SlackApp.Logger.info(`[github-sync] completed reminder ${ArgReminderID} (${ArgReason})`);
    return true;
  }

  /**
   * Complete a reminder in response to a checkbox change in a synced per-user Slack List.
   * Mirrors {@link RemindersModule#CompleteReminderByIdAsync} but is labelled as list-originated.
   * @param {string} ArgReminderID Reminder ID to complete.
   * @param {string} ArgReason Reason for completion.
   * @returns {Promise<boolean>}
   */
  async CompleteReminderFromListAsync(ArgReminderID, ArgReason) {
    const Reminder = this.#PendingRemindersQueue.find(ArgReminder => ArgReminder.ReminderID === ArgReminderID);
    if(!Reminder) {
      this.#SlackApp.Logger.warn(`[lists-sync] reminder ${ArgReminderID} not found for completion`);
      return false;
    }

    this.#TransitionReminderState(Reminder, RemindersModule.ReminderState.Completed, ArgReason);
    await this.#DeleteRemindersAsync([ArgReminderID], 'completed');
    this.#SlackApp.Logger.info(`[lists-sync] completed reminder ${ArgReminderID} (${ArgReason})`);
    return true;
  }

  /**
   * Cancel a reminder in response to a row deletion in a synced per-user Slack List.
   * This is the first public cancel path in the module; the wastebasket reaction has its
   * own internal path.
   * @param {string} ArgReminderID Reminder ID to cancel.
   * @param {string} ArgReason Reason for cancellation.
   * @returns {Promise<boolean>}
   */
  async CancelReminderFromListAsync(ArgReminderID, ArgReason) {
    const Reminder = this.#PendingRemindersQueue.find(ArgReminder => ArgReminder.ReminderID === ArgReminderID);
    if(!Reminder) {
      this.#SlackApp.Logger.warn(`[lists-sync] reminder ${ArgReminderID} not found for cancellation`);
      return false;
    }

    this.#TransitionReminderState(Reminder, RemindersModule.ReminderState.Canceled, ArgReason);
    await this.#DeleteRemindersAsync([ArgReminderID], 'canceled');
    this.#SlackApp.Logger.info(`[lists-sync] canceled reminder ${ArgReminderID} (${ArgReason})`);
    return true;
  }

  /**
   * Update a reminder's editable task summary from a synced Slack List row.
   * Preserves the original reminder envelope when possible, only rewriting the mutable
   * task-summary section that backs the Slack List title.
   * @param {string} ArgReminderID Reminder ID to update.
   * @param {string} ArgSummaryMrkdwn New summary in Slack mrkdwn format.
   * @param {string} ArgReason Reason for the edit.
   * @returns {Promise<boolean>}
   */
  async UpdateReminderSummaryFromListAsync(ArgReminderID, ArgSummaryMrkdwn, ArgReason) {
    const Reminder = this.#PendingRemindersQueue.find(ArgReminder => ArgReminder.ReminderID === ArgReminderID);
    if(!Reminder) {
      this.#SlackApp.Logger.warn(`[lists-sync] reminder ${ArgReminderID} not found for summary update`);
      return false;
    }

    const NewSummary = typeof ArgSummaryMrkdwn === 'string' ? ArgSummaryMrkdwn.trim() : '';
    if(!NewSummary) {
      this.#SlackApp.Logger.warn(`[lists-sync] reminder ${ArgReminderID} summary update ignored because the new summary was empty`);
      return false;
    }

    const CurrentSummary = SlackFormatUtils.ExtractKeyTasks(Reminder.ReminderMessageText);
    if(CurrentSummary === NewSummary) {
      return true;
    }

    Reminder.ReminderMessageText = SlackFormatUtils.ReplaceReminderSummary(
      Reminder.ReminderMessageText,
      NewSummary
    );
    await this.#SaveRemindersAsync();
    this.#SlackApp.Logger.info(`[lists-sync] updated reminder ${ArgReminderID} summary (${ArgReason})`);
    return true;
  }

  /**
   * Create a new reminder from a row a user authored directly in a synced Slack List.
   *
   * A list row carries no source-message context, so OriginalMessageID is left empty and
   * OriginalChannelID falls back to the target channel. The reminder is queued without the
   * usual Slack List fan-out — the caller adopts the existing authored row instead.
   * @param {{summary: string, dueDate: string, assigneeID: string|null, targetChannelID: string, originalSenderID: string|null}} ArgRowData
   *   Minimum column contract extracted from the list row.
   * @returns {Promise<{ok: boolean, reminder?: ReminderInfo, error?: string}>}
   */
  async CreateReminderFromListRowAsync(ArgRowData) {
    const Summary = typeof ArgRowData.summary === 'string' ? ArgRowData.summary.trim() : '';
    if(!Summary) {
      return { ok: false, error: 'missing summary' };
    }

    const ParsedDate = ArgRowData.dueDate ? new Date(ArgRowData.dueDate) : null;
    if(!ParsedDate || isNaN(ParsedDate.getTime())) {
      return { ok: false, error: 'missing or unparseable due date' };
    }

    if(typeof ArgRowData.targetChannelID !== 'string' || ArgRowData.targetChannelID.length === 0) {
      return { ok: false, error: 'missing target channel' };
    }

    // a list row has no authoring user when created_by is unavailable; fall back so the
    // sender/assignee indexes stay populated.
    const SenderID = ArgRowData.originalSenderID || ArgRowData.assigneeID || ArgRowData.targetChannelID;
    const AssigneeID = ArgRowData.assigneeID || SenderID;

    const NewReminderInfo = this.#MakeScheduledReminder({
      ShouldPostOn: ParsedDate,
      TargetChannelID: ArgRowData.targetChannelID,
      OriginalChannelID: ArgRowData.targetChannelID,
      OriginalChannelName: null,
      OriginalMessageID: '',
      OriginalThreadTs: null,
      OriginalSenderID: SenderID,
      ReminderMessageText: Summary,
      AssigneeID: AssigneeID,
      AssigneeIDs: [AssigneeID],
      GitHubUrls: null,
    });

    // SkipListSync: the caller adopts the existing authored row rather than creating a duplicate.
    await this.#QueueReminderAsync(NewReminderInfo, { SkipListSync: true });
    this.#SlackApp.Logger.info(`[lists-sync] created reminder ${NewReminderInfo.ReminderID} from a hand-authored list row`);
    return { ok: true, reminder: NewReminderInfo };
  }

  /**
   * Set the ListsModule instance for integration with Slack Lists.
   * @param {import('./lists-module')} ArgListsModule Lists module instance.
   */
  SetListsModule(ArgListsModule) {
    this.#ListsModule = ArgListsModule;
  }

  /**
   * Set the GitHub sync module instance for debug/testing integration.
   * @param {import('./github-sync-module')} ArgGitHubSyncModule GitHub sync module instance.
   */
  SetGitHubSyncModule(ArgGitHubSyncModule) {
    this.#GitHubSyncModule = ArgGitHubSyncModule;
  }

  /**
   * Start the reminders system.
   * @param {import('./stats-module').WorkspaceStats} ArgWorkspaceStats Stats for the workspace.
   * @returns {Promise<void>}
   */
  async StartAsync(ArgWorkspaceStats) {
    // initialize the WorkspaceAI instance.
    this.#WorkspaceAI = new WorkspaceAI(this.#SlackApp.WorkspaceInfo, ArgWorkspaceStats);

    // populate snooze days from workspace configuration.
    this.#SnoozeDays = new Set(
      (this.#SlackApp.WorkspaceInfo.SNOOZE_DAYS ?? []).map(d => d.toLowerCase())
    );

    // compute the reminders directory path and ensure it exists.
    const RemindersDirPath = path.resolve(path.join(__dirname, '..', 'data', 'runtime', 'reminders'));
    await fs.mkdir(RemindersDirPath, { recursive: true });
    try {
      const TestPath = path.join(RemindersDirPath, `.tmp_${Date.now()}`);
      await fs.writeFile(TestPath, 'test');
      await fs.unlink(TestPath);
    } catch(error) {
      this.#SlackApp.Logger.warn('reminders directory is not writable:', error);
    }

    // compute the file paths for all reminder-related files.
    const WorkspaceName = this.#SlackApp.WorkspaceInfo.WORKSPACE_NAME;
    this.#ReminderFilePath = path.join(RemindersDirPath, `${WorkspaceName}_reminders.json`);
    this.#ReminderCounterFilePath = path.join(RemindersDirPath, `${WorkspaceName}_reminder_counter.json`);
    this.#TrashedExamplesFilePath = path.join(RemindersDirPath, `${WorkspaceName}_trashed_examples.jsonl`);
    this.#TrashedExamplesCursorFilePath = path.join(RemindersDirPath, `${WorkspaceName}_trashed_examples_cursor.json`);
    const EnabledChannelsFilePath = path.join(RemindersDirPath, `${WorkspaceName}_enabled_channels.json`);

    // load Sleuth's own completion history (powers the weekly summary; independent of Slack Lists).
    this.#CompletionStore = new CompletionStore(
      this.#SlackApp,
      path.join(RemindersDirPath, `${WorkspaceName}_completed.json`)
    );
    await this.#CompletionStore.LoadAsync();

    // P3 Phase 1 (NON-authoritative): append-only lifecycle ledger. A side log under
    // data/runtime/events/<workspace>_events.jsonl; the store creates the dir on first append.
    // Best-effort — nothing reads it back yet (projections consume it out-of-band), so there is
    // no LoadAsync and no boot dependency on it.
    this.#EventStore = createEventStore({
      rootDir: path.join(RemindersDirPath, '..', 'events'),
    });
    this.#EventWorkspace = WorkspaceName;

    // instantiate the channel settings manager.
    this.#ChannelSettings = new RemindersChannelSettings(this.#SlackApp, EnabledChannelsFilePath);

    // instantiate the AI pipeline for reminder analysis, date extraction, and deduplication.
    this.#AIPipeline = new RemindersAIPipeline(this.#WorkspaceAI, this.#SlackApp, () => this.#PendingRemindersQueue);

    // instantiate the reaction handler for managing emoji-driven lifecycle transitions.
    this.#ReactionHandler = new RemindersReactionHandler(this.#SlackApp, {
      GetPendingReminders: () => this.#PendingRemindersQueue,
      DeleteRemindersAsync: (ArgReminderIDs, ArgReason) => this.#DeleteRemindersAsync(ArgReminderIDs, ArgReason),
      TryScheduleRemindersAsync: (ArgMessageText, ArgChannelID, ArgTimestamp, ArgUserID, ArgForceSchedule) =>
        this.#TryScheduleRemindersAsync(this.#SlackApp, ArgMessageText, ArgChannelID, ArgTimestamp, ArgUserID, ArgForceSchedule),
      PostReminderTriageAsync: (ArgChannelID, ArgTimestamp, ArgReactingUserID) =>
        this.#PostReminderTriageAsync(ArgChannelID, ArgTimestamp, ArgReactingUserID),
      SaveTrashedExampleAsync: (ArgExample) => this.#SaveTrashedExampleAsync(ArgExample),
      /** @type {(ArgReminder: any, ArgNextState: 'scheduled'|'due'|'overdue'|'snoozed'|'posting'|'posted'|'rescheduled'|'failed'|'completed'|'canceled'|'dead-letter', ArgReason: string) => void} */
      TransitionReminderState: (ArgReminder, ArgNextState, ArgReason) =>
        this.#TransitionReminderState(ArgReminder, ArgNextState, ArgReason),
      ReminderState: RemindersModule.ReminderState,
    });

    // register the reaction handler with the Slack app.
    this.#SlackApp.HandleReactionAdded(this.#ReactionHandler.OnReactionAddedAsync.bind(this.#ReactionHandler));

    // load the reminder counter from disk. If this fails, we start with the default values.
    try {
      // load the reminder counter from disk.
      this.#SlackApp.Logger.info("loading reminder counter from file:", this.#ReminderCounterFilePath);
      const ReminderCounterData = await fs.readFile(this.#ReminderCounterFilePath, 'utf8');
      const ReminderCounterInfo = JSON.parse(ReminderCounterData);

      // set the reminder counter and last reset date from the loaded data.
      this.#ReminderCounter = ReminderCounterInfo.ReminderCounter;
      this.#ReminderCounterLastReset = new Date(ReminderCounterInfo.ReminderCounterLastReset);
      this.#LastDailyDigestDate = ReminderCounterInfo.LastDailyDigestDate || null;
      this.#SlackApp.Logger.info("loaded reminder counter from file:", this.#ReminderCounterFilePath);
    } catch(error) {
      // if the file does not exist or is corrupted or any other error occurs, just start the counter state
      // with the default values.
      // TODO: this is hardcoded to 15:00 UTC == 8:00 AM PST. It needs to respect the configured time zone.
      this.#ReminderCounter = 1;
      this.#ReminderCounterLastReset = new Date();
      this.#ReminderCounterLastReset.setUTCHours(15, 0, 0, 0);
      this.#SlackApp.Logger.error("starting with default reminder counter state due to error:", error);
    }

    // load enabled channels from disk.
    await this.#ChannelSettings.LoadEnabledChannelsAsync();

    // indicate that the reminders system is starting and where the reminders are being loaded from.
    this.#SlackApp.Logger.info("initializing reminders system from file:", this.#ReminderFilePath);

    // load the reminders from disk. If this fails, let the error bubble up so the caller can decide what
    // to do (trying to proceed with an empty list is tantamount to losing all reminders).
    await this.#LoadRemindersAsync();

    // start the reminder timer. We use setTimeout instead of setInterval to avoid overlapping timer calls which can
    // happen since setInterval does not wait for the previous timer call to complete before starting the next one.
    // https://nodejs.org/en/learn/asynchronous-work/discover-javascript-timers#recursive-settimeout
    this.#ReminderTimerID = setTimeout(async function ProcessRemindersAsync() {
      // check for pending reminders and process them. Log errors but do not stop the timer so we can retry later.
      try {
        await this.#CheckRemindersAsync();
      } catch(error) {
        this.#SlackApp.Logger.error("error while processing reminders:", error);
      }

      // schedule the next reminder check.
      this.#ReminderTimerID = setTimeout(ProcessRemindersAsync.bind(this), this.#ReminderCheckInterval);
    }.bind(this), this.#ReminderCheckInterval);

    // schedule daily task digest.
    await this.#StartDailyDigestSchedulerAsync();

    // schedule weekly false-positive report.
    this.#StartWeeklyReportScheduler();
  }

  /**
   * Show reminders for a user using deterministic command routing.
   * @param {import('./slack-app').AppMentionEventInfo|import('./slack-app').MessageEventInfo} ArgEventInfo Event payload.
   * @param {string} ArgUserMention Slack user mention used to filter reminders.
   * @param {{ limitToCurrentChannel?: boolean }} [ArgOptions] Additional options for reminder filtering.
   * @returns {Promise<boolean>}
   */
  async ShowRemindersForUserDeterministicAsync(ArgEventInfo, ArgUserMention, ArgOptions) {
    try {
      return await this.#AppMentionHandler.ShowRemindersForUserDeterministicAsync(
        this.#SlackApp,
        ArgEventInfo,
        ArgUserMention,
        ArgOptions
      );
    } catch(error) {
      this.#SlackApp.Logger.error("error in ShowRemindersForUserDeterministicAsync:", error);
      return false;
    }
  }

  /**
   * Force-run the daily digest immediately, bypassing the duplicate-send guard.
   * Admin only — intended for debug and manual testing.
   * @returns {Promise<void>}
   */
  async RunDailyDigestNowAsync() {
    await this.#RunDailyTaskDigestAsync(true);
  }

  /**
   * Stop the reminders system.
   * @returns {Promise<void>}
   */
  async StopAsync() {
    // clear the reminder timer and save state to disk.
    clearTimeout(this.#ReminderTimerID);
    this.#StopDailyDigestScheduler();
    await this.#SaveRemindersAsync();
    await this.#ChannelSettings.SaveEnabledChannelsAsync();

    // save the reminder counter state to disk.
    await this.#SaveReminderCounterAsync();

    // The queue save above awaits the chain as it stood then, but the calls after it can queue
    // another (and GitHubCommentRelay's callback saves without awaiting). Drain once more so a
    // save queued during shutdown is not lost.
    await this.FlushRemindersAsync();

    // completion history is written fire-and-forget from the FSM hook; flush any queued write so a
    // completion recorded just before this shutdown survives the restart/deploy.
    if(this.#CompletionStore) {
      await this.#CompletionStore.FlushAsync();
    }
  }

  /**
   * Handle Slack message event and return true on success.
   * @param {SlackApp} ArgSlackApp Slack app instance.
   * @param {import('./slack-app').MessageEventInfo} ArgEventInfo Event payload.
   * @returns {Promise<boolean>}
   */
  async #OnMessageAsync(ArgSlackApp, ArgEventInfo) {
    if(!this.#ChannelSettings) {
      this.#SlackApp.Logger.warn('ignoring reminder message before channel settings finished initializing.');
      return false;
    }

    if(!this.#AIPipeline) {
      this.#SlackApp.Logger.warn('ignoring reminder message before reminders startup finished initializing.');
      return false;
    }

    // check if reminders are enabled for this channel; if not, opportunistically add a :mag:
    // discovery hint so users notice Sleuth would have scheduled this had the channel been enabled.
    // a 1:1 DM has no multi-user "channel" to opt in, so scheduling triggers work by default there
    // (same as an explicit @Sleuth mention already does today) — GH-412.
    const IsDirectMessage = ArgEventInfo.channel_type === 'im';
    if(!IsDirectMessage && !this.#ChannelSettings.AreRemindersEnabledForChannel(ArgEventInfo.channel)) {
      await this.#TryAddDiscoveryHintReactionAsync(ArgSlackApp, ArgEventInfo);
      return false;
    }

    // Skip attachment-only messages (e.g. image shares with no caption): empty text gives the
    // LLM no real context and causes it to hallucinate task descriptions.
    if(!ArgEventInfo.text?.trim()) return false;

    // Intercept "do/handle/complete the above" shorthand in thread replies before general AI
    // analysis. These messages often lack an @Sleuth mention and arrive as message events rather
    // than app_mention events, so the CommandRouter in RemindersAppMentionHandler never sees them.
    if(ArgEventInfo.thread_ts) {
      const WasHandled = await this.#AppMentionHandler.TryHandleTaskAboveShorthandAsync(ArgSlackApp, ArgEventInfo);
      if(WasHandled) return true;

      // When the message is a vague commitment ("will do it at 10pm") rather than an explicit
      // "do above" command, enrich the scheduler context with the preceding message so the AI
      // derives a meaningful task title instead of extracting the placeholder pronoun.
      const WasEnriched = await this.#AppMentionHandler.TryEnrichVagueCompletionFromAboveAsync(ArgSlackApp, ArgEventInfo);
      if(WasEnriched) return true;
    }

    // Skip messages with no temporal language — if there is no time reference the LLM must invent
    // both the scheduling trigger and the task title, which causes hallucination (see 1.4.142).
    if(!this.#AppMentionHandler.HasSchedulingTrigger(ArgEventInfo.text)) return false;

    const TriggerMatch = this.#AppMentionHandler.GetSchedulingTriggerMatch(ArgEventInfo.text);
    ArgSlackApp.Logger.info(
      `reminder path fired: path=message_event_auto_schedule enrichment=none temporal_trigger="${TriggerMatch}"`
    );

    // attempt to schedule reminders for the message.
    return await this.#TryScheduleRemindersAsync(
      ArgSlackApp, ArgEventInfo.text, ArgEventInfo.channel, ArgEventInfo.ts, ArgEventInfo.user,
      false, // don't force scheduling if no scheduling triggers are found in the message.
      ArgEventInfo.thread_ts ?? null
    );
  }

  /**
   * Add a :mag: reaction to messages in disabled channels that look schedulable.
   * Uses the shared cheap regex heuristic — no AI calls. Silently no-ops on bot messages,
   * thread replies, or when the heuristic does not match.
   * @param {SlackApp} ArgSlackApp Slack app instance.
   * @param {import('./slack-app').MessageEventInfo} ArgEventInfo Event payload.
   * @returns {Promise<void>}
   */
  async #TryAddDiscoveryHintReactionAsync(ArgSlackApp, ArgEventInfo) {
    // skip bot messages and messages with no sender.
    if(!ArgEventInfo.user || ArgEventInfo.user === ArgSlackApp.BotUserID) return;

    // skip thread replies — top-level messages are the right surface for the hint.
    if(ArgEventInfo.thread_ts && ArgEventInfo.thread_ts !== ArgEventInfo.ts) return;

    // run the cheap heuristic; skip if it does not match.
    if(!RemindersAIPipeline.DetectDirectAskWithTimeTrigger(ArgEventInfo.text)) return;

    // add the :mag: reaction; AddReactionAsync swallows errors internally and returns false on failure.
    const Added = await ArgSlackApp.AddReactionAsync(ArgEventInfo.channel, ArgEventInfo.ts, 'mag');
    if(Added) {
      this.#SlackApp.Logger.info(
        `[discovery-hint] added :mag: to schedulable-looking message in disabled channel ${ArgEventInfo.channel}`
      );
    }
  }

  /**
   * Get reminders where the given user is the assignee (the intended recipient).
   * Uses the #RemindersByAssignee index for O(1) lookup — no queue scan required.
   * This is the correct function for "show my reminders" and per-user digest views.
   * @param {string} ArgUserID Assignee user ID.
   * @returns {ReminderInfo[]}
   */
  #GetRemindersTargetingUserID(ArgUserID) {
    return this.#RemindersByAssignee.get(ArgUserID) ?? [];
  }

  /**
   * Get reminders broadly involving the given user: reminders they created, are assigned to, or are text-mentioned in.
   * Intended for "search my reminders" and other broad-scope queries.
   * @param {string} ArgUserID User ID to search reminders for.
   * @returns {ReminderInfo[]}
   */
  #GetRemindersInvolvingUserID(ArgUserID) {
    const SeenReminderIds = new Set();
    const UserReminders = [];

    // start with reminders the user created (sender bucket).
    const CreatedReminders = this.#RemindersBySender.get(ArgUserID) ?? [];
    for(const reminder of CreatedReminders) {
      SeenReminderIds.add(reminder.ReminderID);
      UserReminders.push(reminder);
    }

    // add reminders assigned to the user that the sender bucket didn't already cover.
    const AssignedReminders = this.#RemindersByAssignee.get(ArgUserID) ?? [];
    for(const reminder of AssignedReminders) {
      if(!SeenReminderIds.has(reminder.ReminderID)) {
        SeenReminderIds.add(reminder.ReminderID);
        UserReminders.push(reminder);
      }
    }

    // add reminders where the user is text-mentioned but is neither sender nor assignee.
    const UserMentionPattern = `<@${ArgUserID}>`;
    for(const reminder of this.#PendingRemindersQueue) {
      if(SeenReminderIds.has(reminder.ReminderID)) continue;
      if(reminder.ReminderMessageText.includes(UserMentionPattern)) {
        SeenReminderIds.add(reminder.ReminderID);
        UserReminders.push(reminder);
      }
    }

    return UserReminders;
  }

  /**
   * AI-driven scheduling gateway and schedule-on-message entrypoint. Returns true on success.
   *
   * All event-driven reminder creation — auto-scheduling from #OnMessageAsync, alarm_clock
   * reactions, app-mention commands, task-above, vague-completion enrichment — funnels through
   * this method via the injected TryScheduleRemindersAsync callback.
   *
   * DO NOT add a parallel code path that constructs a ReminderInfo and calls #QueueReminderAsync
   * without going through this method or CreateReminderFromListRowAsync. Doing so bypasses:
   *   - LLM analysis and ForceSchedule override logic
   *   - Duplicate detection (#CheckForDuplicateReminderAsync)
   *   - Date extraction and past-date forward-adjustment
   *   - Target channel resolution (#GetReminderChannelIdAsync)
   *   - GitHub URL extraction
   *   - Feedback/confirmation message posted to Slack
   *   - #MakeScheduledReminder FSM entry invariants
   *
   * @param {SlackApp} ArgSlackApp Slack app instance.
   * @param {string} ArgMessageText Text of the message to analyze for reminders.
   * @param {string} ArgChannelID Channel where the message was posted.
   * @param {string} ArgMessageID ID/timestamp of the message.
   * @param {string} ArgUserID ID of user who sent the message.
   * @param {boolean} ArgForceSchedule If true and no scheduling triggers are found, simulate "tomorrow morning".
   * @param {string|null} [ArgThreadTs] Thread timestamp when the source message is a reply.
   * @param {string|null} [ArgLiveReplyText] Raw live reply text before any thread-context enrichment.
   * @param {boolean} [ArgUsedEnrichedThreadContext] True when ArgMessageText includes prepended thread context.
   * @returns {Promise<boolean>}
   */
  async #TryScheduleRemindersAsync(
    ArgSlackApp,
    ArgMessageText,
    ArgChannelID,
    ArgMessageID,
    ArgUserID,
    ArgForceSchedule,
    /** @type {string|null} */ ArgThreadTs = null,
    /** @type {string|null} */ ArgLiveReplyText = null,
    ArgUsedEnrichedThreadContext = false
  ) {
    if(!this.#AIPipeline) {
      this.#SlackApp.Logger.warn('skipping reminder scheduling before reminders startup finished initializing.');
      return false;
    }

    const StructuralPath = ArgForceSchedule
      ? 'force_schedule'
      : (ArgUsedEnrichedThreadContext ? 'enriched_thread_reply' : 'message_event_auto_schedule');
    const TriggerSourceText = ArgUsedEnrichedThreadContext && ArgLiveReplyText
      ? ArgLiveReplyText
      : ArgMessageText;
    const TriggerMatch = this.#AppMentionHandler.GetSchedulingTriggerMatch(TriggerSourceText) || 'none';

    // analyze the message for reminders.
    let AnalysisResult = await this.#AIPipeline.AnalyzeMessageForRemindersAsync(ArgMessageText);
    ArgSlackApp.Logger.info(`reminder analysis result:`, AnalysisResult.recommendation);

    let UsedSyntheticForceSchedule = false;

    // if force scheduling is enabled and no triggers are found, we simulate a reminder for "tomorrow morning".
    if(ArgForceSchedule && (AnalysisResult.recommendation === 'ignore' || AnalysisResult.reminders.length === 0)) {
      UsedSyntheticForceSchedule = true;
      let ForceScheduledReminderMessage = ArgMessageText;
      // only spend an LLM call to synthesize a concise task title when synthesis is enabled for THIS
      // message's length segment; when it is off the original message text is the displayed task
      // (selected verbatim by #SelectReminderTaskText), so the call would be wasted. Fall back to the
      // original message if synthesis fails.
      if(RemindersAIPipeline.IsTaskSynthesisEnabledForText(
        RemindersAIPipeline.NormalizeOriginalReminderText(ArgMessageText)
      )) {
        try {
          ForceScheduledReminderMessage = await this.#AIPipeline.ExtractManualReminderTaskAsync(ArgMessageText);
        } catch(error) {
          ArgSlackApp.Logger.error('failed to infer manual reminder task text, falling back to original message:', error);
        }
      }

      AnalysisResult = {
        recommendation: 'schedule',
        rationale: 'Simulated reminder for "tomorrow morning" since no scheduling triggers were found.',
        reminders: [{
          actionable_language: ArgMessageText, // treat entire message as actionable when force-scheduling.
          scheduling_trigger: 'tomorrow morning',
          reminder_message: ForceScheduledReminderMessage,
        }]
      };
    }

    const ShouldSuppressWeakReply =
      ArgUsedEnrichedThreadContext &&
      !ArgForceSchedule &&
      AnalysisResult.recommendation === 'schedule' &&
      this.#ShouldSuppressWeakEnrichedReply(ArgLiveReplyText);

    if(ArgUsedEnrichedThreadContext) {
      this.#SlackApp.Logger.info(
        `reminder enriched-reply safety check: path=${StructuralPath} temporal_trigger="${TriggerMatch}" weak_live_reply=${ShouldSuppressWeakReply ? 'yes' : 'no'}`
      );
    }

    if(
      ShouldSuppressWeakReply
    ) {
      this.#SlackApp.Logger.info(
        'suppressing enriched reminder scheduling because the live reply is weak acknowledgment / hypothetical language.'
      );
      return true;
    }

    const DisplaySourceMessageText = RemindersAIPipeline.NormalizeOriginalReminderText(
      ArgUsedEnrichedThreadContext && ArgLiveReplyText
        ? ArgLiveReplyText
        : ArgMessageText
    );
    const DisplayQuoteSource = ArgUsedEnrichedThreadContext && ArgLiveReplyText
      ? 'live_reply'
      : 'message_text';
    // synthesis routing is now length-aware (GH-337 Phase 2): the same normalized original drives
    // both the displayed task selection and this log line, so digest/triage can never disagree.
    const SynthesisRouting = RemindersAIPipeline.DescribeSynthesisRouting(
      DisplaySourceMessageText, AnalysisResult.reminders
    );
    const DisplayTaskSource = SynthesisRouting.synthesisOn
      ? 'ai_synthesized_task_title'
      : DisplayQuoteSource === 'live_reply'
        ? 'live_reply_verbatim'
        : 'message_text_verbatim';
    // Phase 4 telemetry: one structured line per scheduled message. No raw message text is logged —
    // only a character length, sentence count, derived actionable-span ratio, and the routing decision,
    // so the 4-sentence threshold can be confirmed against real data before defaults are locked.
    ArgSlackApp.Logger.info(
      `reminder display source: path=${StructuralPath} temporal_trigger="${TriggerMatch}"` +
      ` quote_source=${DisplayQuoteSource} task_source=${DisplayTaskSource}` +
      ` msg_len=${SynthesisRouting.messageLength} sentences=${SynthesisRouting.sentenceCount}` +
      ` segment=${SynthesisRouting.segment} synthesis=${SynthesisRouting.synthesisOn ? 'on' : 'off'}` +
      ` actionable_span_ratio=${SynthesisRouting.actionableSpanRatio}`
    );

    // NOTE: the displayed task text (verbatim vs. synthesized analyzer brief) is now selected lazily by
    // #SelectReminderTaskText, which both the scheduling and triage paths funnel through. There is no
    // longer a mutating override of `reminder_message` here — keeping the analyzer's candidates intact
    // is what lets the auto-scheduled digest and the :wrench: triage view agree by construction.

    // collapse candidates that render to the same bullet under the same trigger. The GPT analyzer can
    // emit multiple reminder candidates for one scheduling trigger (e.g. one per numbered item in a
    // single message). With text synthesis OFF the override above rewrites every candidate's display
    // text to the identical original message, so those candidates would otherwise produce N byte-for-byte
    // identical bullets in both the "Key task(s)" reminder body and the "Tasks for ..." feedback message
    // — even though only ONE reminder is queued per trigger group. Dedupe on the rendered identity
    // (trigger + displayed task text) so each distinct bullet appears once. This is a no-op when synthesis
    // is ON and candidates carry distinct titles, and correctly collapses genuine duplicate extractions.
    const SeenReminderRenderKeys = new Set();
    AnalysisResult.reminders = AnalysisResult.reminders.filter(CurrentReminderInfo => {
      const RenderKey = `${CurrentReminderInfo.scheduling_trigger} ${this.#SelectReminderTaskText(CurrentReminderInfo, DisplaySourceMessageText)}`;
      if(SeenReminderRenderKeys.has(RenderKey)) return false;
      SeenReminderRenderKeys.add(RenderKey);
      return true;
    });

    // exit early if the recommendation is to ignore the message.
    if(AnalysisResult.recommendation === 'ignore') return false;

    // exit early if there are no reminders to schedule. This should not happen unless the GPT model is broken.
    if(AnalysisResult.reminders.length === 0) return false;

    // group reminders by their scheduling trigger so we can schedule them together.
    const RemindersByTrigger = /** @type {Record<string, GptReminderInfo[]>} */ ({});
    for(const CurrentReminderInfo of AnalysisResult.reminders) {
      // initialize the array for the current trigger if it doesn't exist.
      if(!RemindersByTrigger[CurrentReminderInfo.scheduling_trigger])
        RemindersByTrigger[CurrentReminderInfo.scheduling_trigger] = [];

      // add the reminder to the array for the current trigger.
      RemindersByTrigger[CurrentReminderInfo.scheduling_trigger].push(CurrentReminderInfo);
    }

    // track successfully scheduled reminders for display in the feedback message.
    const SuccessfullyScheduledReminders = /** @type {Map<ReminderInfo, GptReminderInfo[]>} */ (new Map());
    
    // track which reminders had their dates adjusted from past to future.
    const AdjustedReminders = /** @type {Set<ReminderInfo>} */ (new Set());

    // schedule reminders for each group of reminders with the same scheduling trigger.
    for(const [CurrentTrigger, CurrentReminders] of Object.entries(RemindersByTrigger)) {
      // log details of reminders to be scheduled.
      ArgSlackApp.Logger.info(`\nscheduling ${CurrentReminders.length} reminders for trigger: "${CurrentTrigger}"`);

      // extract the date from the trigger.
      const ExtractionResult = await this.#AIPipeline.ExtractDateWithGptAsync(CurrentTrigger);

      // skip this trigger if no date was extracted.
      if(!ExtractionResult.success || !ExtractionResult.date) {
        ArgSlackApp.Logger.info("failed to extract date from trigger:", CurrentTrigger);
        continue;
      }

      // log the extraction result to help with debugging.
      ArgSlackApp.Logger.info("successfully extracted date:", ExtractionResult.date.toUTCString());
      if(ExtractionResult.wasAdjustedForward) {
        ArgSlackApp.Logger.info(`note: date was in the past and adjusted forward by 24 hours`);
      }

      // extract GitHub issue and PR URLs before reminder text sanitization strips them.
      const GitHubUrls = this.#ExtractGitHubUrls(ArgMessageText);

      // compose the reminder message text.
      let NewReminderMessageText = await this.#ComposeReminderMessageAsync(
        ArgUserID, ArgChannelID, ArgMessageID, DisplaySourceMessageText, ArgMessageText
      );

      // append bulleted list of key tasks to the reminder message. NOTE: the reminder messages shown here were
      // extracted by the GPT model and are not the same as the message text sent by the user.
      NewReminderMessageText = CurrentReminders.reduce((ArgAccumulatedText, ArgCurrentReminder) => {
        return ArgAccumulatedText + `\n• ${this.#SelectReminderTaskText(ArgCurrentReminder, DisplaySourceMessageText)}`;
      }, NewReminderMessageText + "\n\nKey task(s):");

      // get the channel ID where we will post the reminder, falling back to the original channel if lookup fails.
      const TargetChannelID = await this.#GetReminderChannelIdAsync(ArgChannelID);

      // Extract every explicitly mentioned human assignee from the original quoted source. The
      // factory retains the first one in AssigneeID for older readers while the array is authoritative.
      const ExtractedAssigneeIDs = this.#ExtractAssigneeIDsFromReminderText(NewReminderMessageText);
      const AssigneeIDs = ExtractedAssigneeIDs.length > 0 ? ExtractedAssigneeIDs : [ArgUserID];

      // get channel name while we have access (bot received the message, so it should have access)
      const OriginalChannelName = await this.#SlackApp.GetChannelNameAsync(ArgChannelID);

      // create the reminder object via the FSM factory (owns ReminderID, CreatedOn, State, IgnoreSnooze).
      const NewReminderInfo = this.#MakeScheduledReminder({
        ShouldPostOn: ExtractionResult.date,
        TargetChannelID: TargetChannelID,
        OriginalChannelID: ArgChannelID,
        OriginalChannelName: OriginalChannelName,
        OriginalMessageID: ArgMessageID,
        OriginalThreadTs: ArgThreadTs ?? null,
        OriginalSenderID: ArgUserID,
        ReminderMessageText: NewReminderMessageText,
        AssigneeID: AssigneeIDs[0],
        AssigneeIDs: AssigneeIDs,
        GitHubUrls: GitHubUrls.length > 0 ? GitHubUrls : null,
      });

      // check for duplicate reminders before queueing, unless force scheduling is enabled (this serves as an escape
      // hatch for the user to force a reminder even if it is considered a duplicate).
      if(!ArgForceSchedule) {
        ArgSlackApp.Logger.info(`checking for duplicate reminder ${NewReminderInfo.ReminderID}...`);
        const DedupResult = await this.#AIPipeline.CheckForDuplicateReminderAsync(NewReminderInfo);
        if(DedupResult.recommendation === 'ignore') {
          // log the duplicate detection and rationale.
          ArgSlackApp.Logger.info(
            `skipping duplicate reminder ${NewReminderInfo.ReminderID}:`, DedupResult.rationale
          );

          // add gemini reaction to original message to indicate it was detected as a duplicate.
          try {
            const ReactionAdded = await ArgSlackApp.AddReactionAsync(ArgChannelID, ArgMessageID, 'gemini');
            if(ReactionAdded) {
              ArgSlackApp.Logger.info('added gemini reaction to duplicate reminder message.');
            } else {
              ArgSlackApp.Logger.error('failed to add gemini reaction to duplicate reminder message.');
            }
          } catch(error) {
            ArgSlackApp.Logger.error(`error adding gemini reaction:`, error);
          }

          continue; // skip to next reminder in the loop.
        }
      } else {
        const DedupResult = await this.#AIPipeline.CheckForDuplicateReminderAsync(NewReminderInfo);
        if(DedupResult.recommendation === 'ignore' && DedupResult.matched_by === 'message_id') {
          ArgSlackApp.Logger.info('Force-scheduled reminder has the same OriginalMessageID. Skipping scheduling.');
          continue; // skip to next reminder in the loop.
        }
        if(DedupResult.recommendation === 'ignore') {
          ArgSlackApp.Logger.info(
            `bypassing semantic duplicate check for force-scheduled reminder ${NewReminderInfo.ReminderID}:`,
            DedupResult.rationale
          );
        } else {
          ArgSlackApp.Logger.info(`no duplicate found for force-scheduled reminder ${NewReminderInfo.ReminderID}`);
        }
      }

      // queue the reminder to be posted at the appropriate time.
      try {
        await this.#QueueReminderAsync(NewReminderInfo);
        SuccessfullyScheduledReminders.set(NewReminderInfo, CurrentReminders);

        if(Array.isArray(NewReminderInfo.GitHubUrls) && NewReminderInfo.GitHubUrls.length > 0) {
          ArgSlackApp.Logger.info(
            `[github-sync] tagged reminder ${NewReminderInfo.ReminderID} with ${NewReminderInfo.GitHubUrls.length} GitHub URL(s): ${NewReminderInfo.GitHubUrls.join(', ')}`
          );
        }
        
        // track if this reminder had its date adjusted.
        if(ExtractionResult.wasAdjustedForward && !UsedSyntheticForceSchedule) {
          AdjustedReminders.add(NewReminderInfo);
        }
      } catch(error) {
        ArgSlackApp.Logger.error("failed to queue reminder:", error);
      }
    }

    // compose and post feedback message if any reminders were scheduled.
    if(SuccessfullyScheduledReminders.size > 0) {
      // build the feedback message.
      let FeedbackMessage = this.#ComposeFeedbackMessageText(ArgUserID, SuccessfullyScheduledReminders, AdjustedReminders, DisplaySourceMessageText);

      // connection surfacing — append a footnote of related open work. Purely additive and fully
      // defensive: any failure here must never block reminder creation (the FSM is already committed).
      try {
        const RelatedFootnote = await this.#BuildConnectionFootnoteAsync(
          Array.from(SuccessfullyScheduledReminders.keys())
        );
        if(RelatedFootnote) FeedbackMessage += `\n${RelatedFootnote}`;
      } catch(error) {
        ArgSlackApp.Logger.warn('connection surfacing failed (non-fatal):', error);
      }

      // collect reminder IDs to store in metadata.
      const ReminderIDs = Array.from(SuccessfullyScheduledReminders.keys()).map(r => r.ReminderID);

      // create metadata for the feedback message.
      const MessageMetadata = /** @type {import('./slack-app').MessageMetadata} */({
        event_type: 'sleuth-ai-reminder-ids',
        event_payload: {
          ReminderIDs: JSON.stringify(ReminderIDs)
        }
      });

      // post the feedback message as a reply to the original message.
      await ArgSlackApp.PostMessageTextAsync(ArgChannelID, ArgMessageID, FeedbackMessage, MessageMetadata, { Tag: 'reminders-feedback' });

      // return true to indicate that the event was handled.
      return true;
    }

    // if we get here, no reminders were scheduled so return false to indicate the event wasn't handled.
    return false;
  }

  /**
   * Return true when an enriched thread reply should be suppressed because the live reply text is
   * weak acknowledgment / hypothetical language rather than a strong commitment or direct ask.
   * This is a narrow deterministic backstop for the enriched-context path only.
   * @param {string|null} ArgLiveReplyText Raw live reply text prior to prepending thread context.
   * @returns {boolean}
   */
  #ShouldSuppressWeakEnrichedReply(ArgLiveReplyText) {
    const LiveReplyText = (ArgLiveReplyText || '').replace(/\s+/g, ' ').trim();
    if(!LiveReplyText) return false;

    const HasWeakAcknowledgment = [
      /\bkeep\s+(?:that|this|it)\s+in\s+mind\b/i,
      /\b(?:i\s+am|i'm)\s+assuming\s+the\s+goal\s+is\b/i,
      /\bthe\s+goal\s+is\s+to\s+be\s+able\s+to\b/i,
      /\b(?:sounds\s+good|i\s+understand|understood)\b/i,
      /\b(?:when|if)\s+i\s+get\s+to\s+(?:the\s+)?(?:it|this|that|[a-z0-9_-]+)\b/i,
    ].some((ArgPattern) => ArgPattern.test(LiveReplyText));

    if(!HasWeakAcknowledgment) return false;

    const HasStrongCommitment = [
      /\b(?:can\s+you|could\s+you|would\s+you|please)\b/i,
      /\bi(?:'ll|\s+will|\s+am\s+going\s+to|'m\s+going\s+to)\s+(?:do|handle|take\s+care\s+of|finish|complete|tackle|work\s+on|follow\s+up\s+on|review|send|deploy|fix|ship|address|talk\s+to|discuss|check|update)\b/i,
      /\b(?:gonna|going\s+to)\s+(?:do|handle|take\s+care\s+of|finish|complete|tackle|work\s+on|follow\s+up\s+on|review|send|deploy|fix|ship|address|talk\s+to|discuss|check|update)\b/i,
    ].some((ArgPattern) => ArgPattern.test(LiveReplyText));

    return !HasStrongCommitment;
  }

  /**
   * Post a reminder triage diagnostic message in a child thread for a specific message.
   * @param {string} ArgChannelID Channel ID where the target message exists.
   * @param {string} ArgMessageID Target message timestamp.
   * @param {string} ArgReactingUserID User who requested diagnostics via :wrench:.
   * @returns {Promise<boolean>}
   */
  async #PostReminderTriageAsync(ArgChannelID, ArgMessageID, ArgReactingUserID) {
    if(!this.#AIPipeline) {
      this.#SlackApp.Logger.warn('reminder triage requested before reminders startup finished initializing.');
      return false;
    }

    const ThreadMessages = await this.#SlackApp.GetConversationMessagesAsync(ArgChannelID, ArgMessageID);
    const OriginalMessage = ThreadMessages[0];
    if(!OriginalMessage) {
      this.#SlackApp.Logger.error('could not find original message for wrench reminder triage.');
      return false;
    }

    // guard against empty/missing text (file shares, message_changed, block-kit-only messages).
    const OriginalText = typeof OriginalMessage.text === 'string' ? OriginalMessage.text.trim() : '';
    if(!OriginalText) {
      await this.#SlackApp.PostMessageTextAsync(
        ArgChannelID,
        ArgMessageID,
        `:wrench: Reminder triage requested by <@${ArgReactingUserID}>, but this message has no text to triage (file share, edit, or block-kit message).`,
        undefined,
        { Tag: 'reminder-triage' }
      );
      return true;
    }

    // resolve channel status so the user can see whether auto-scheduling is actually enabled here.
    const AutoSchedulingEnabled = this.#ChannelSettings
      ? this.#ChannelSettings.AreRemindersEnabledForChannel(ArgChannelID)
      : false;
    const ReminderTargetChannelID = await this.#GetReminderChannelIdAsync('');
    const IsReminderTargetChannel = ReminderTargetChannelID === ArgChannelID;
    const ConfiguredTargetChannelName = this.#SlackApp.WorkspaceInfo.REMINDER_CHANNEL_NAME || '(not configured)';

    const TriageResult = await this.#AIPipeline.GetReminderTriageAsync(OriginalText);
    const FeedbackLines = [
      `:wrench: Reminder triage requested by <@${ArgReactingUserID}>.`,
      '*Channel status:*',
      `• Auto-scheduling in this channel: *${AutoSchedulingEnabled ? 'enabled' : 'disabled'}*`,
      `• Reminder target channel: #${SlackFormatUtils.SanitizeForInlineSlack(ConfiguredTargetChannelName)}${IsReminderTargetChannel ? ' _(this channel)_' : ''}`,
    ];

    if(!AutoSchedulingEnabled) {
      FeedbackLines.push('• :information_source: Auto-scheduling is disabled here — messages in this channel will not be analyzed. Channel creator can enable with `@Sleuth AI enable reminders`.');
    }

    FeedbackLines.push(
      '*AI analysis:*',
      `• Recommendation: *${SlackFormatUtils.SanitizeForInlineSlack(TriageResult.analysis.recommendation)}*`,
      `• Rationale: ${SlackFormatUtils.SanitizeForInlineSlack(TriageResult.analysis.rationale, 400)}`,
      `• Reminder candidates: ${TriageResult.analysis.reminders.length}`,
    );

    if(TriageResult.analysis.reminders.length === 0) {
      FeedbackLines.push('• No reminder candidates were extracted from this message.');
    } else {
      for(let ReminderIndex = 0; ReminderIndex < TriageResult.analysis.reminders.length; ReminderIndex++) {
        const Reminder = TriageResult.analysis.reminders[ReminderIndex];
        const DateResult = TriageResult.dateExtractions[ReminderIndex];

        const SanitizedTrigger = SlackFormatUtils.SanitizeForInlineSlack(Reminder.scheduling_trigger);
        const SanitizedTask = SlackFormatUtils.SanitizeForInlineSlack(
          this.#SelectReminderTaskText(Reminder, RemindersAIPipeline.NormalizeOriginalReminderText(OriginalText))
        );
        FeedbackLines.push(
          `• Candidate ${ReminderIndex + 1}: trigger="${SanitizedTrigger}", task="${SanitizedTask}"`
        );

        if(!DateResult.success) {
          FeedbackLines.push('  ↳ date parse: failed');
          continue;
        }

        const ParsedDate = DateResult.date ? DateResult.date.toUTCString() : 'unknown';
        const AdjustmentTag = DateResult.wasAdjustedForward ? ' (adjusted forward from past time)' : '';
        FeedbackLines.push(`  ↳ date parse: ${ParsedDate}${AdjustmentTag}`);
      }
    }

    await this.#SlackApp.PostMessageTextAsync(ArgChannelID, ArgMessageID, FeedbackLines.join('\n'), undefined, { Tag: 'reminder-triage' });
    return true;
  }

  /**
   * Select the displayed reminder task text — the single chokepoint both the auto-scheduled digest
   * and the :wrench: triage view funnel through, so the same message always renders the same bullet
   * (GH-337 Phase 1). The choice is length-aware (Phase 2): when synthesis is disabled for this
   * message's segment, the normalized original message is shown verbatim; when enabled, the analyzer's
   * brief is used, falling back to the quoted actionable span when that brief is over-compressed.
   * @param {GptReminderInfo} ArgReminderInfo Reminder candidate from the AI analyzer.
   * @param {string} [ArgNormalizedOriginalText] Normalized original message text (verbatim source).
   * @returns {string}
   */
  #SelectReminderTaskText(ArgReminderInfo, ArgNormalizedOriginalText = '') {
    const NormalizedOriginal = (ArgNormalizedOriginalText || '').trim();

    // verbatim path: synthesis disabled for this message's length segment → show the user's wording
    // unchanged. This reproduces the prior synthesis-OFF behavior byte-for-byte.
    if(NormalizedOriginal && !RemindersAIPipeline.IsTaskSynthesisEnabledForText(NormalizedOriginal))
      return SlackFormatUtils.NormalizeUserMentionsToMrkdwn(NormalizedOriginal);

    // synthesis path: reuse the analyzer's brief, with a deterministic quality fallback to the quoted
    // actionable span when the brief looks suspiciously over-compressed relative to that span.
    const ReminderMessage = ArgReminderInfo.reminder_message?.trim() || '';
    const ActionableLanguage = ArgReminderInfo.actionable_language?.trim() || '';
    const ReminderWordCount = ReminderMessage.split(/\s+/).filter(Boolean).length;
    const IsLikelyOverCompressed = ReminderWordCount <= 3 && ActionableLanguage.length > (ReminderMessage.length + 12);

    const TaskText = IsLikelyOverCompressed
      ? ActionableLanguage
      : (ReminderMessage || ActionableLanguage || NormalizedOriginal || 'Task not specified');

    return SlackFormatUtils.NormalizeUserMentionsToMrkdwn(TaskText);
  }

  /**
   * Compose feedback message for scheduled reminders.
   * @param {string} ArgUserID User who sent the original message.
   * @param {Map<ReminderInfo, GptReminderInfo[]>} ArgScheduledReminders Map of scheduled reminders.
   * @param {Set<ReminderInfo>} [ArgAdjustedReminders] Set of reminders that had dates adjusted from past to future.
   * @param {string} [ArgNormalizedOriginalText] Normalized original message text, for verbatim task selection.
   * @returns {string}
   */
  #ComposeFeedbackMessageText(ArgUserID, ArgScheduledReminders, ArgAdjustedReminders, ArgNormalizedOriginalText = '') {
    // start with basic confirmation message.
    const ReminderCount = ArgScheduledReminders.size;
    const ReminderCountText = ReminderCount === 1 ?
      `${ReminderCount} Slack reminder has` : `${ReminderCount} Slack reminders have`;

    // Render the exact normalized assignee set that was persisted, rather than re-parsing message
    // text (which could include incidental mentions that were not assigned).
    const FirstReminder = ArgScheduledReminders.keys().next().value;
    const TargetUsers = RemindersModule.GetAssigneeIDs(FirstReminder, this.#SlackApp.BotUserID);
    const TargetUsersText = TargetUsers.length > 0
      ? TargetUsers.map(ArgID => `<@${ArgID}>`).join(', ')
      : `<@${ArgUserID}>`;

    // "as shared work" is MULTI-ASSIGNEE COPY ONLY. GH-22 adds shared assignment; it does not reword
    // the single-assignee case, where that phrasing reads wrong for one person and breaks the
    // existing confirmation contract asserted in tests/reminders-integration.test.js. One assignee
    // (or none, falling back to the sender) must stay byte-identical to the pre-GH-22 wording.
    const SharedWorkText = TargetUsers.length > 1 ? ' as shared work' : '';
    let FeedbackMessage = `${ReminderCountText} been scheduled${SharedWorkText} for ${TargetUsersText}.`;
    const GitHubMonitoringFeedback = RemindersModule.BuildGitHubMonitoringFeedback(ArgScheduledReminders);
    if(GitHubMonitoringFeedback)
      FeedbackMessage += `\n${GitHubMonitoringFeedback}`;

    // add details for each scheduled reminder.
    for(const [CurrentReminder, CurrentGptReminders] of ArgScheduledReminders.entries()) {
      // format date in Slack's date format for localized display.
      const ShouldPostOnUnixTime = Math.floor(CurrentReminder.ShouldPostOn.getTime() / 1000);
      const ShouldPostOnUtcString = CurrentReminder.ShouldPostOn.toUTCString();
      const SlackDateFormat = `<!date^${ShouldPostOnUnixTime}^{date_long_pretty} at {time}|${ShouldPostOnUtcString}>`;

      // add task summary for the current group of reminders which share the same scheduling trigger.
      FeedbackMessage += `\n\nTasks for ${SlackDateFormat}:`;

      // add note if this reminder's date was adjusted from past to future.
      if(ArgAdjustedReminders && ArgAdjustedReminders.has(CurrentReminder)) {
        FeedbackMessage += `\n⚠️ _Note: The requested time was in the past, so the reminder has been scheduled for the next occurrence._`;
      }

      // infer the client for this reminder once (from channel/repo signals) and prefix each task
      // bullet with its name (GH-395). No confident match → bullets are left unprefixed.
      const ClientName = ResolveClientNameForReminder(CurrentReminder, this.#SlackApp.WorkspaceInfo?.WORKSPACE_NAME);

      for(const CurrentGptReminder of CurrentGptReminders)
        FeedbackMessage += `\n• ${ApplyClientPrefix(this.#SelectReminderTaskText(CurrentGptReminder, ArgNormalizedOriginalText), ClientName)}`;
    }

    // return the composed feedback message.
    return FeedbackMessage;
  }

  /**
   * Build an optional feedback line when scheduled reminders include GitHub URLs.
   * @param {Map<ReminderInfo, GptReminderInfo[]>} ArgScheduledReminders Scheduled reminders map.
   * @returns {string}
   */
  static BuildGitHubMonitoringFeedback(ArgScheduledReminders) {
    let MonitoredGitHubUrlCount = 0;

    for(const CurrentReminder of ArgScheduledReminders.keys()) {
      if(Array.isArray(CurrentReminder.GitHubUrls))
        MonitoredGitHubUrlCount += CurrentReminder.GitHubUrls.length;
    }

    if(MonitoredGitHubUrlCount === 0) return '';
    if(MonitoredGitHubUrlCount === 1) return 'GitHub link now monitored.';
    return `${MonitoredGitHubUrlCount} GitHub links now monitored.`;
  }


  /**
   * Extract human assignee IDs from the quoted original-message section of reminder text.
   * @param {string} ArgReminderMessageText Full reminder message text.
   * @returns {string[]} Ordered, de-duplicated human user IDs.
   */
  #ExtractAssigneeIDsFromReminderText(ArgReminderMessageText) {
    if(!ArgReminderMessageText || typeof ArgReminderMessageText !== 'string') {
      return [];
    }

    // Extract the quoted original message section (after ":\n>")
    const QuoteStartIndex = ArgReminderMessageText.indexOf(':\n>');
    let TextToSearch = ArgReminderMessageText;
    
    if(QuoteStartIndex !== -1) {
      // Extract everything after ":\n>"
      const QuotedSection = ArgReminderMessageText.substring(QuoteStartIndex + 3);
      // The quoted section ends before "Key task(s):" if present
      const KeyTasksIndex = QuotedSection.indexOf('\n\nKey task(s):');
      if(KeyTasksIndex !== -1) {
        TextToSearch = QuotedSection.substring(0, KeyTasksIndex);
      } else {
        TextToSearch = QuotedSection;
      }
    }

    // Extract user mentions from the text
    const UserMentionPattern = /<@([^>|]+)(?:\|[^>]*)?>/g;
    /** @type {string[]} */
    const UserIds = [];
    let Match;
    
    while((Match = UserMentionPattern.exec(TextToSearch)) !== null) {
      const UserId = Match[1];
      if(!UserIds.includes(UserId)) {
        UserIds.push(UserId);
      }
    }

    if(UserIds.length === 0) {
      return [];
    }

    // Filter out the bot user ID - the bot should never be the assignee
    const BotUserID = this.#SlackApp.BotUserID;
    const HumanUserIds = BotUserID
      ? UserIds.filter(Id => Id !== BotUserID)
      : UserIds;

    if(HumanUserIds.length === 0) {
      return [];
    }

    return HumanUserIds;
  }

  /**
   * Backwards-compatible singular extraction used only while loading legacy records. New scheduling
   * always calls #ExtractAssigneeIDsFromReminderText so one reminder can be shared by every target.
   * @param {string} ArgReminderMessageText Full reminder message text.
   * @param {string} ArgOriginalSenderID Original sender ID (kept for legacy call compatibility).
   * @returns {string|null} First human assignee or null.
   */
  #ExtractAssigneeFromReminderText(ArgReminderMessageText, ArgOriginalSenderID) {
    void ArgOriginalSenderID;
    return this.#ExtractAssigneeIDsFromReminderText(ArgReminderMessageText)[0] ?? null;
  }

  /**
   * Extract GitHub issue and pull request URLs from raw Slack message text.
   * @param {string} ArgMessageText Raw message text from Slack.
   * @returns {string[]}
   */
  #ExtractGitHubUrls(ArgMessageText) {
    return ExtractGitHubUrls(ArgMessageText);
  }

  /**
   * Compose a reminder message that links to the original message and optionally quotes message text.
   * @param {string} ArgSenderID ID of user who sent original message.
   * @param {string} ArgChannelID ID of channel where original message was posted.
   * @param {string} ArgMessageID ID of original message.
   * @param {string} ArgQuotedMessageText Message text to quote in the reminder body.
   * @param {string} [ArgMentionSourceText] Message text to scan for user mentions.
   * @returns {Promise<string>}
   */
  async #ComposeReminderMessageAsync(
    ArgSenderID,
    ArgChannelID,
    ArgMessageID,
    ArgQuotedMessageText,
    ArgMentionSourceText = ArgQuotedMessageText
  ) {
    // remove embedded URLs from the message text to avoid malformed Slack quote blocks. This
    // handles both Slack's <https://example.com|link> style and plain URLs.
    const SanitizedMessageText = ArgQuotedMessageText
      // If the message contains a Slack-formatted link like
      // <https://example.com|anchor text> we want to keep the anchor text
      // and discard the URL portion to avoid malformed quote blocks.
      .replace(/<https?:\/\/[^>\s]+\|([^>]+)>/gi, '$1')
      // Remove any remaining angle-bracketed links with no anchor text.
      .replace(/<https?:\/\/[^>]+>/gi, '')
      // Strip out bare URLs that may have been pasted in the message.
      .replace(/https?:\/\/\S+/gi, '')
      .trim();

    // split the sanitized message text into lines then prepend each line with a '>' character to
    // create a blockquote so the original message text is easier to read in the reminder message.
    const QuotedMessageLines = SanitizedMessageText.split("\n")
      .map((ArgMessageLine) => `>${ArgMessageLine}`)
      .join("\n");

    // get a permalink to the original message so we can link to it in the reminder message.
    const MessagePermaLink = await this.#SlackApp.GetPermaLinkAsync(ArgChannelID, ArgMessageID);

    // we need to build a list of users to tag in the reminder message. This should include the user who sent the original
    // message and any users mentioned in the message text. Duplicate mentions should be removed to avoid cluttering the
    // reminder message with redundant mentions. The regex pattern used to match user mentions looks for all strings which
    // start with '<@' and end with '>' (e.g: '<@U12345678>') and the Set object is used to remove duplicate matches. We
    // use the Set object again to remove duplicates from the final list of mentions (e.g. if the sender is also mentioned
    // in the message they sent, we don't want to mention them twice). The comma-separated list of users to tag is built
    // from the final list of unique mentions.
    const MentionedUserList = [`<@${ArgSenderID}>`, ...new Set(ArgMentionSourceText.match(/<@[^>]+>/g) || [])];
    const UsersToTag = [...new Set(MentionedUserList)].join(", ");

    // if we couldn't get a permalink, the best we can do is quote the original message text and mention the channel.
    if(!MessagePermaLink)
      return `${UsersToTag} - please follow up on this message posted in <#${ArgChannelID}>:\n${QuotedMessageLines}`;

    // if we get here, we have a permalink to the original message so we can link to it in the reminder message.
    let ReminderMessageText = `${UsersToTag} - please follow up on <${MessagePermaLink}|this>`;
    return `${ReminderMessageText}:\n${QuotedMessageLines}`;
  }

  /**
   * Get the channel ID where reminders should be posted.
   * @param {string} ArgFallbackChannelID Channel ID to use if configured channel is not found.
   * @returns {Promise<string>}
   */
  async #GetReminderChannelIdAsync(ArgFallbackChannelID) {
    // return cached ID if available.
    if(this.#ReminderChannelID) return this.#ReminderChannelID;

    // get configured channel name from workspace info.
    const ReminderChannelName = this.#SlackApp.WorkspaceInfo.REMINDER_CHANNEL_NAME;

    // look up channel ID using name.
    this.#ReminderChannelID = await this.#SlackApp.GetChannelIdAsync(ReminderChannelName);

    // log the resolved channel ID.
    this.#SlackApp.Logger.info("caching channel ID for reminders:", this.#ReminderChannelID);

    // return the channel ID or fallback if lookup failed. NOTE: the fallback channel ID isn't cached
    // so that we can retry the lookup if the configured channel is created later.
    return this.#ReminderChannelID || ArgFallbackChannelID;
  }

  /**
   * Parse configured daily digest time or fall back to default 08:00.
   * @returns {{ hour: number, minute: number }} Parsed hour and minute.
   */
  #GetDailyDigestTimeParts() {
    const ConfiguredTime = this.#SlackApp.WorkspaceInfo.DAILY_TASK_DIGEST_TIME || '08:00';
    const TimeMatch = ConfiguredTime.match(/^(\d{1,2}):(\d{2})$/);

    if(!TimeMatch)
      return { hour: 8, minute: 0 };

    const HourValue = Math.min(Math.max(parseInt(TimeMatch[1], 10), 0), 23);
    const MinuteValue = Math.min(Math.max(parseInt(TimeMatch[2], 10), 0), 59);

    return { hour: HourValue, minute: MinuteValue };
  }

  /**
   * Calculate the next UTC time to post the daily digest.
   * @returns {Date} Date representing next run time.
   */
  #CalculateNextDailyDigestTime() {
    const CurrentDate = DateUtils.GetCurrentDateInTimeZone(
      this.#SlackApp.WorkspaceInfo.MAIN_TIMEZONE
    );
    const { hour, minute } = this.#GetDailyDigestTimeParts();

    // Log current state for debugging
    this.#SlackApp.Logger.info(`[DIGEST CALC] Current date in timezone: ${CurrentDate.toUTCString()}`);
    this.#SlackApp.Logger.info(`[DIGEST CALC] Configured time: ${hour}:${minute}`);
    this.#SlackApp.Logger.info(`[DIGEST CALC] Workspace timezone: ${this.#SlackApp.WorkspaceInfo.MAIN_TIMEZONE}`);

    // extract date components (these represent the date in the workspace timezone).
    const Year = CurrentDate.getUTCFullYear();
    const Month = CurrentDate.getUTCMonth();
    const Day = CurrentDate.getUTCDate();

    // create a UTC date with the desired hour/minute (treating them as workspace timezone values).
    const TempDate = new Date(Date.UTC(Year, Month, Day, hour, minute, 0, 0));
    this.#SlackApp.Logger.info(`[DIGEST CALC] TempDate: ${TempDate.toUTCString()}`);

    // adjust by timezone offset to convert from workspace timezone to actual UTC timestamp.
    const OffsetMinutes = DateUtils.GetTimeZoneOffsetInMinutes(
      this.#SlackApp.WorkspaceInfo.MAIN_TIMEZONE
    );
    this.#SlackApp.Logger.info(`[DIGEST CALC] Offset minutes: ${OffsetMinutes}`);

    const TargetDate = new Date(TempDate.getTime() - (OffsetMinutes * 60 * 1000));
    this.#SlackApp.Logger.info(`[DIGEST CALC] TargetDate (UTC): ${TargetDate.toUTCString()}`);
    this.#SlackApp.Logger.info(`[DIGEST CALC] TargetDate in LA time: ${TargetDate.toLocaleString('en-US', { timeZone: this.#SlackApp.WorkspaceInfo.MAIN_TIMEZONE })}`);

    // if the target time has already passed today, schedule for tomorrow.
    if(TargetDate.getTime() <= Date.now()) {
      this.#SlackApp.Logger.info('[DIGEST CALC] Target time already passed, scheduling for tomorrow');
      TargetDate.setUTCDate(TargetDate.getUTCDate() + 1);
      this.#SlackApp.Logger.info(`[DIGEST CALC] Tomorrow\'s TargetDate: ${TargetDate.toUTCString()}`);
      this.#SlackApp.Logger.info(`[DIGEST CALC] Tomorrow\'s TargetDate in LA time: ${TargetDate.toLocaleString('en-US', { timeZone: this.#SlackApp.WorkspaceInfo.MAIN_TIMEZONE })}`);
    }

    return TargetDate;
  }

  /**
   * Stop and clear the daily digest scheduler timer.
   */
  #StopDailyDigestScheduler() {
    if(this.#DailyDigestTimerID) {
      clearTimeout(this.#DailyDigestTimerID);
      this.#DailyDigestTimerID = null;
    }
  }

  /**
   * Start the daily digest scheduler using configured time.
   * @returns {Promise<void>}
   */
  async #StartDailyDigestSchedulerAsync() {
    this.#StopDailyDigestScheduler();

    const NextRunTime = this.#CalculateNextDailyDigestTime();
    const DelayMs = Math.max(NextRunTime.getTime() - Date.now(), 1000);
    this.#SlackApp.Logger.info(
      `daily task digest scheduled for ${NextRunTime.toUTCString()} (${DelayMs}ms delay)`
    );

    this.#DailyDigestTimerID = setTimeout(async () => {
      try {
        await this.#RunDailyTaskDigestAsync();
      } catch(error) {
        this.#SlackApp.Logger.error('error running daily task digest:', error);
      } finally {
        await this.#StartDailyDigestSchedulerAsync();
      }
    }, DelayMs);
  }

  /**
   * Compute the UTC timestamp of the next Monday at 08:00 in the workspace timezone.
   * If today is already Monday and 08:00 has not yet passed, returns today's 08:00.
   * @returns {Date}
   */
  #CalculateNextWeeklyReportTime() {
    const CurrentDate = DateUtils.GetCurrentDateInTimeZone(this.#SlackApp.WorkspaceInfo.MAIN_TIMEZONE);
    const OffsetMinutes = DateUtils.GetTimeZoneOffsetInMinutes(this.#SlackApp.WorkspaceInfo.MAIN_TIMEZONE);

    const Year = CurrentDate.getUTCFullYear();
    const Month = CurrentDate.getUTCMonth();
    const Day = CurrentDate.getUTCDate();
    const DayOfWeek = CurrentDate.getUTCDay(); // 0=Sunday … 6=Saturday (already in workspace TZ via DateUtils)

    // Days to advance to reach Monday (0 if today IS Monday).
    const DaysUntilMonday = DayOfWeek === 1 ? 0 : (8 - DayOfWeek) % 7;

    // Build 08:00 workspace-local time as a UTC offset-adjusted timestamp.
    const TempDate = new Date(Date.UTC(Year, Month, Day + DaysUntilMonday, 8, 0, 0, 0));
    const TargetDate = new Date(TempDate.getTime() - (OffsetMinutes * 60 * 1000));

    // If that moment is already in the past, advance a full week.
    if(TargetDate.getTime() <= Date.now())
      TargetDate.setUTCDate(TargetDate.getUTCDate() + 7);

    return TargetDate;
  }

  /**
   * Schedule the weekly false-positive report, replacing any existing timer.
   */
  #StartWeeklyReportScheduler() {
    if(this.#WeeklyReportTimerID) {
      clearTimeout(this.#WeeklyReportTimerID);
      this.#WeeklyReportTimerID = null;
    }

    const NextRunTime = this.#CalculateNextWeeklyReportTime();
    const DelayMs = Math.max(NextRunTime.getTime() - Date.now(), 1000);
    this.#SlackApp.Logger.info(`weekly false-positive report scheduled for ${NextRunTime.toUTCString()} (${DelayMs}ms delay)`);

    this.#WeeklyReportTimerID = setTimeout(async () => {
      try {
        await this.#RunWeeklyTrashedExamplesReportAsync();
      } catch(error) {
        this.#SlackApp.Logger.error('error running weekly false-positive report:', error);
      } finally {
        this.#StartWeeklyReportScheduler();
      }
    }, DelayMs);
  }

  /**
   * Read new trashed-example entries since the last run, call the AI pipeline to analyze them,
   * and post the Slack-formatted pattern summary to REMINDER_CHANNEL_NAME.
   * Skips silently when there are no new entries.
   * @returns {Promise<void>}
   */
  async #RunWeeklyTrashedExamplesReportAsync() {
    // Read the cursor (number of JSONL lines already processed by a previous run).
    let ProcessedLineCount = 0;
    try {
      const CursorData = await fs.readFile(this.#TrashedExamplesCursorFilePath, 'utf8');
      ProcessedLineCount = JSON.parse(CursorData).lineCount || 0;
    } catch { /* first run or missing cursor — start from line 0 */ }

    // Read the JSONL file and split into individual lines.
    let AllLines = /** @type {string[]} */ ([]);
    try {
      const RawContent = await fs.readFile(this.#TrashedExamplesFilePath, 'utf8');
      AllLines = RawContent.split('\n').filter(l => l.trim());
    } catch { /* JSONL file doesn't exist yet — nothing to report */ }

    const NewLines = AllLines.slice(ProcessedLineCount);
    if(NewLines.length === 0) {
      this.#SlackApp.Logger.info('weekly-false-positive-report: no new examples since last run, skipping.');
      return;
    }

    // Parse new entries; silently drop malformed lines.
    const NewEntries = NewLines
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);

    if(NewEntries.length === 0) return;

    // Resolve the reminder channel before doing any expensive work.
    const ChannelID = await this.#GetReminderChannelIdAsync('');
    if(!ChannelID) {
      this.#SlackApp.Logger.warn('weekly-false-positive-report: REMINDER_CHANNEL_NAME not configured — skipping post.');
      return;
    }

    // Ask the AI pipeline to identify patterns and suggest new prompt rules.
    const LlmReport = await this.#AIPipeline.AnalyzeTrashedExamplesAsync(NewEntries);

    // Post the report to Slack.
    const Count = NewEntries.length;
    const Header = `*Weekly false-positive reminder report* — ${Count} trashed reminder${Count === 1 ? '' : 's'} since last week`;
    await this.#SlackApp.PostMessageTextAsync(ChannelID, null, `${Header}\n\n${LlmReport}`, undefined, { Tag: 'weekly-false-positive-report' });
    this.#SlackApp.Logger.info(`weekly-false-positive-report: posted summary of ${Count} example(s).`);

    // Advance the cursor only after a successful post so a failed run retries next week.
    // Crash-atomic (GH-12): a truncated cursor would fail to parse and reset lineCount to 0,
    // re-reporting every historical example in next week's digest.
    await WriteFileDurableAsync(
      this.#TrashedExamplesCursorFilePath,
      JSON.stringify({ lineCount: AllLines.length }),
      { Logger: this.#SlackApp.Logger }
    );
  }

  /**
   * Build map of reminders grouped by user.
   * Returned reminder objects are original ReminderInfo records from queue, including IgnoreSnooze.
   * @returns {Map<string, ReminderInfo[]>}
   */
  #BuildReminderMapByUser() {
    const CandidateUsers = new Set();
    const BotUserID = this.#SlackApp.BotUserID;

    for(const reminder of this.#PendingRemindersQueue) {
      const AssigneeIDs = RemindersModule.GetAssigneeIDs(reminder, BotUserID);
      if(AssigneeIDs.length > 0) {
        for(const AssigneeID of AssigneeIDs) CandidateUsers.add(AssigneeID);
        continue;
      }

      const MentionMatches = reminder.ReminderMessageText.match(/<@([^>]+)>/g) || [];
      for(const mention of MentionMatches) {
        const MentionMatch = mention.match(/^<@([^>]+)>$/);
        if(MentionMatch && MentionMatch[1] && MentionMatch[1] !== BotUserID)
          CandidateUsers.add(MentionMatch[1]);
      }
    }

    const RemindersByUser = new Map();
    for(const userId of CandidateUsers) {
      const UserReminders = this.#GetRemindersTargetingUserID(userId);
      if(UserReminders.length > 0)
        RemindersByUser.set(userId, UserReminders);
    }

    return RemindersByUser;
  }

  /**
   * Format date string for daily digest header.
   * @param {Date} ArgDate Date to format.
   * @returns {string} Date string in MM-DD-YY format.
   */
  #FormatDailyDigestDate(ArgDate) {
    const Month = `${ArgDate.getUTCMonth() + 1}`.padStart(2, '0');
    const Day = `${ArgDate.getUTCDate()}`.padStart(2, '0');
    const Year = `${ArgDate.getUTCFullYear()}`.slice(-2);
    return `${Month}-${Day}-${Year}`;
  }

  /**
   * Get today's date string in workspace timezone (YYYY-MM-DD format).
   * Used for duplicate digest prevention tracking.
   * @returns {string}
   */
  #GetTodayDateString() {
    const CurrentDate = DateUtils.GetCurrentDateInTimeZone(
      this.#SlackApp.WorkspaceInfo.MAIN_TIMEZONE
    );
    const Year = CurrentDate.getUTCFullYear();
    const Month = String(CurrentDate.getUTCMonth() + 1).padStart(2, '0');
    const Day = String(CurrentDate.getUTCDate()).padStart(2, '0');
    return `${Year}-${Month}-${Day}`;
  }

  /**
   * Post a daily digest thread for a specific user.
   * @param {string} ArgChannelID Channel ID where the thread should be created.
   * @param {string} ArgUserID User ID for the thread owner.
   * @param {ReminderInfo[]} ArgReminders Reminders to include in the thread.
   * @param {string} ArgDateText Formatted date text for header.
   * @returns {Promise<string|null>} The thread ts of the top-level digest message, or null on failure.
   */
  async #PostDailyTaskThreadAsync(ArgChannelID, ArgUserID, ArgReminders, ArgDateText) {
    try {
      const ParentMessage = `Daily tasks for ${ArgDateText} for <@${ArgUserID}>`;
      const ThreadTs = await this.#SlackApp.PostMessageTextAsync(ArgChannelID, null, ParentMessage, undefined, { Tag: 'daily-digest' });

      if(!ThreadTs) {
        this.#SlackApp.Logger.warn(`unable to create daily task thread for user ${ArgUserID}`);
        return null;
      }

      const SyntheticEventInfo = {
        channel: ArgChannelID,
        ts: ThreadTs,
        user: ArgUserID,
        text: `<@${ArgUserID}>`
      };

      // GH-337 Phase 3: compact digest excerpting lives in the shared display helper so the
      // daily digest, show-reminders surfaces, and rebalance export all render the same text.
      const Timezone = this.#SlackApp.WorkspaceInfo.MAIN_TIMEZONE;
      const EmptyMessage = `No pending reminders found for <@${ArgUserID}>.`;
      await PostBucketedReminderSectionsAsync(
        this.#SlackApp,
        SyntheticEventInfo,
        ArgReminders,
        EmptyMessage,
        '',
        Timezone,
        { auditTag: 'daily-digest' }
      );
      return ThreadTs;
    } catch(error) {
      this.#SlackApp.Logger.error(`error posting daily task thread for user ${ArgUserID}:`, error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Proactive digest signals (#362 Phase 1)
  // ---------------------------------------------------------------------------

  /**
   * Default number of quiet days before a client is flagged as "gone quiet".
   * @type {number}
   */
  static #PROACTIVE_QUIET_DAYS_DEFAULT = 14;

  /**
   * Deadline-collision look-ahead window in milliseconds (48 h).
   * @type {number}
   */
  static #PROACTIVE_DEADLINE_WINDOW_MS = 48 * 60 * 60 * 1000;

  /**
   * Default aging threshold (days) before an unowned item is surfaced.
   * @type {number}
   */
  static #PROACTIVE_AGING_DAYS_DEFAULT = 30;

  /**
   * Maximum number of proactive signals surfaced per digest.
   * @type {number}
   */
  static #PROACTIVE_CAP = 3;

  /**
   * Severity ranks used to sort signals before capping.  Lower number = higher severity.
   * deadlineCollision (1) > agingWithoutOwner (2) > goneQuiet (3)
   * @type {Object<string, number>}
   */
  static #PROACTIVE_SEVERITY = Object.freeze({
    deadlineCollision: 1,
    agingWithoutOwner: 2,
    goneQuiet: 3,
  });

  /**
   * Compute deterministic proactive digest signals from the live queue + completion store.
   * Returns an array of signal objects sorted by severity, ready for capping and rendering.
   *
   * Each signal has the shape:
   *   { type: string, clientId: string|null, label: string, taskIds: string[], details: string }
   *
   * No model call is made; every predicate is purely data-driven.
   *
   * @param {number} [ArgNowMs] Current epoch-ms (injectable for tests; defaults to Date.now()).
   * @returns {{ type: string, clientId: string|null, label: string, taskIds: string[], details: string }[]}
   */
  #ComputeProactiveDigestSignals(ArgNowMs = Date.now()) {
    return RemindersModule.ComputeProactiveSignalsFromData({
      queue: this.#PendingRemindersQueue,
      store: this.#CompletionStore,
      settings: this.#GetProactiveDigestSettings(),
      workspaceInfo: this.#SlackApp.WorkspaceInfo,
      getClientDefaults: (/** @type {string} */ ArgClientId) => GetClientDefaults(ArgClientId),
      nowMs: ArgNowMs,
    });
  }

  /**
   * Render the proactive digest section as a Slack-formatted string.
   * Returns an empty string when there are no signals (noise budget rule: render nothing).
   * Caps at PROACTIVE_CAP signals; overflow reported as "and N more".
   *
   * @param {Array<{ type: string, clientId: string|null, label: string, taskIds: string[], details: string }>} ArgSignals
   * @returns {string}
   */
  #RenderProactiveDigestSection(ArgSignals) {
    if(!ArgSignals || ArgSignals.length === 0) return '';

    const Cap = RemindersModule.#PROACTIVE_CAP;
    const Shown = ArgSignals.slice(0, Cap);
    const Overflow = ArgSignals.length - Shown.length;

    const Lines = ['*Proactive signals:*'];
    for(const Signal of Shown) {
      Lines.push(`• ${Signal.label} — ${Signal.details}`);
    }
    if(Overflow > 0) {
      Lines.push(`_…and ${Overflow} more signal${Overflow === 1 ? '' : 's'}_`);
    }
    return Lines.join('\n');
  }

  /**
   * Compute and post the proactive signals section to an existing thread (if any signals fire).
   * Silently no-ops when the kill switch is off or zero signals computed.
   *
   * @param {string} ArgChannelID Channel to post into.
   * @param {string} ArgThreadTs Thread timestamp to reply into.
   * @param {number} [ArgNowMs] Injectable epoch-ms for tests.
   * @returns {Promise<void>}
   */
  async #PostProactiveDigestSectionAsync(ArgChannelID, ArgThreadTs, ArgNowMs = Date.now()) {
    if(!this.#GetProactiveDigestSettings().enabled) return;
    const Signals = this.#ComputeProactiveDigestSignals(ArgNowMs);
    const Section = this.#RenderProactiveDigestSection(Signals);
    if(!Section) return;
    await this.#SlackApp.PostMessageTextAsync(ArgChannelID, ArgThreadTs, Section, undefined, { Tag: 'proactive-digest' });
  }

  /**
   * Parse a DeadlineConvention string (e.g. "Sunday 21:00 America/Los_Angeles deploy") and
   * return the epoch-ms of the next occurrence of that day+time at or after ArgNowMs.
   * Returns null when the string is missing or cannot be parsed.
   *
   * Format: "<DayOfWeek> <HH:MM> [<Timezone>] [<label>...]"
   * Only DayOfWeek and HH:MM are required; everything else is ignored here.
   *
   * @param {string|null|undefined} ArgConvention
   * @param {number} ArgNowMs
   * @returns {number|null}
   */
  static ParseDeadlineConventionNextMs(ArgConvention, ArgNowMs) {
    if(!ArgConvention) return null;
    const Parts = ArgConvention.trim().split(/\s+/);
    if(Parts.length < 2) return null;

    const DayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const TargetDow = DayNames.indexOf(Parts[0].toLowerCase());
    if(TargetDow === -1) return null;

    const TimeParts = Parts[1].split(':');
    if(TimeParts.length < 2) return null;
    const TargetHour = Number(TimeParts[0]);
    const TargetMin  = Number(TimeParts[1]);
    if(isNaN(TargetHour) || isNaN(TargetMin)) return null;

    // Extract optional IANA timezone from Part[2] (e.g. "America/Los_Angeles").
    // A valid IANA zone contains a '/' and is not a plain label word.
    let Timezone = null;
    if(Parts.length >= 3 && Parts[2].includes('/')) {
      try {
        // Validate by constructing a formatter; throws RangeError for invalid zones.
        Intl.DateTimeFormat('en-US', { timeZone: Parts[2] });
        Timezone = Parts[2];
      } catch(_) {
        // Not a valid IANA timezone — fall through and use process timezone.
      }
    }

    // Walk forward from ArgNowMs up to 7 days to find the next occurrence of (TargetDow, TargetHour:TargetMin).
    // When Timezone is set, day-of-week and local time are resolved in that zone; otherwise process timezone.
    for(let Offset = 0; Offset <= 7; Offset++) {
      const ProbeMs = ArgNowMs + Offset * 24 * 60 * 60 * 1000;
      let CandidateMs;

      if(Timezone) {
        // Find what local wall-clock date it is in the target timezone at ProbeMs,
        // then build a Date whose wall-clock time in that zone is TargetHour:TargetMin:00.
        const Parts = new Intl.DateTimeFormat('en-US', {
          timeZone: Timezone,
          year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(new Date(ProbeMs));
        const PartMap = Object.fromEntries(Parts.map(p => [p.type, p.value]));
        // Build a date string in ISO-like form and use Intl to convert it back.
        // We construct the wall-clock instant in the target timezone by formatting an ISO string
        // that Temporal-style APIs would parse, but since we only have Intl we do the following:
        // Create a UTC date at 00:00 of the probed local date, then add hours+min.
        const Year  = Number(PartMap.year);
        const Month = Number(PartMap.month) - 1;
        const Day   = Number(PartMap.day);
        // Construct the wall-clock instant: YYYY-MM-DDTHH:MM:00 in the target zone.
        // Use a reference UTC epoch for that local midnight by subtracting the zone offset.
        // The zone offset at midnight: compute it by checking what UTC time corresponds to local midnight.
        const ApproxMidnightMs = Date.UTC(Year, Month, Day);
        // Fine-tune: Intl tells us what local time corresponds to ApproxMidnightMs.
        const LocalParts = new Intl.DateTimeFormat('en-US', {
          timeZone: Timezone,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).formatToParts(new Date(ApproxMidnightMs));
        const LP = Object.fromEntries(LocalParts.map(p => [p.type, p.value]));
        const LocalHour   = Number(LP.hour === '24' ? '0' : LP.hour);
        const LocalMinute = Number(LP.minute);
        const LocalSecond = Number(LP.second);
        const OffsetMs = LocalHour * 3600000 + LocalMinute * 60000 + LocalSecond * 1000;
        const MidnightUtcMs = ApproxMidnightMs - OffsetMs;
        CandidateMs = MidnightUtcMs + TargetHour * 3600000 + TargetMin * 60000;

        // Verify the candidate's day-of-week in the target timezone.
        const CandidateParts = new Intl.DateTimeFormat('en-US', {
          timeZone: Timezone,
          weekday: 'long',
        }).formatToParts(new Date(CandidateMs));
        const CandidateWeekday = (CandidateParts.find(p => p.type === 'weekday')?.value || '').toLowerCase();
        const CandidateDow = DayNames.indexOf(CandidateWeekday);
        if(CandidateDow === TargetDow && CandidateMs >= ArgNowMs) {
          return CandidateMs;
        }
      } else {
        // No timezone — use process local time (original behavior).
        const Base = new Date(ArgNowMs);
        const Candidate = new Date(Base);
        Candidate.setDate(Base.getDate() + Offset);
        Candidate.setHours(TargetHour, TargetMin, 0, 0);
        if(Candidate.getDay() === TargetDow && Candidate.getTime() >= ArgNowMs) {
          return Candidate.getTime();
        }
      }
    }
    return null;
  }

  /**
   * Pure-function test hook: compute proactive digest signals from plain data.
   * Accepts the same inputs as #ComputeProactiveDigestSignals but as plain arguments so tests
   * can call it without constructing a full RemindersModule instance.
   *
   * @param {object} ArgParams
   * @param {any[]} ArgParams.queue Open-queue items (ReminderInfo-shaped plain objects).
   * @param {{ GetLastCompletionMsForClientId?: (clientId: string, windowStartMs: number) => number|null }|null} ArgParams.store CompletionStore instance (or null).
   * @param {{ enabled: boolean, goneQuiet: boolean, deadlineCollision: boolean, agingWithoutOwner: boolean }} ArgParams.settings Proactive settings.
   * @param {{ PROACTIVE_QUIET_DAYS?: string, PROACTIVE_AGING_DAYS?: string }} [ArgParams.workspaceInfo] WorkspaceInfo overrides (PROACTIVE_QUIET_DAYS etc.).
   * @param {((clientId: string) => { PROACTIVE_QUIET_DAYS?: string, DeadlineConvention?: string })|null} [ArgParams.getClientDefaults]
   *   Function returning the Defaults block for a client (used for per-client quiet-window overrides
   *   and DeadlineConvention lookups). Defaults to returning {} for every client when not provided.
   * @param {number} [ArgParams.nowMs] Injectable epoch-ms (defaults to Date.now()).
   * @returns {{ type: string, clientId: string|null, label: string, taskIds: string[], details: string }[]}
   */
  static ComputeProactiveSignalsFromData({ queue, store, settings, workspaceInfo = {}, getClientDefaults = null, nowMs = Date.now() }) {
    if(!settings.enabled) return [];

    const GetDefaults = typeof getClientDefaults === 'function'
      ? getClientDefaults
      : () => ({});

    const OpenStates = new Set([
      RemindersModule.ReminderState.Scheduled,
      RemindersModule.ReminderState.Overdue,
      RemindersModule.ReminderState.Snoozed,
      RemindersModule.ReminderState.Posting,
      RemindersModule.ReminderState.Posted,
      RemindersModule.ReminderState.Rescheduled,
      RemindersModule.ReminderState.Failed,
    ]);

    const OpenItems = queue.filter(ArgR => OpenStates.has(ArgR.State));
    if(OpenItems.length === 0) return [];

    const ByClient = new Map();
    for(const Item of OpenItems) {
      if(!Item.clientId) continue;
      if(!ByClient.has(Item.clientId)) ByClient.set(Item.clientId, []);
      ByClient.get(Item.clientId).push(Item);
    }

    const Signals = [];

    // 1. Gone quiet — default 14 days; per-client Defaults.PROACTIVE_QUIET_DAYS overrides;
    //    workspace-level PROACTIVE_QUIET_DAYS is the fallback between per-client and default.
    if(settings.goneQuiet) {
      const WorkspaceQuietDays = workspaceInfo.PROACTIVE_QUIET_DAYS != null
        ? Number(workspaceInfo.PROACTIVE_QUIET_DAYS)
        : RemindersModule.#PROACTIVE_QUIET_DAYS_DEFAULT;
      for(const [ClientId, Items] of ByClient.entries()) {
        // Per-client override takes precedence over workspace-level.
        const ClientDefaults = /** @type {{ PROACTIVE_QUIET_DAYS?: string, DeadlineConvention?: string }} */ (GetDefaults(ClientId));
        const QuietDays = ClientDefaults.PROACTIVE_QUIET_DAYS != null
          ? Number(ClientDefaults.PROACTIVE_QUIET_DAYS)
          : WorkspaceQuietDays;
        const WindowStartMs = nowMs - QuietDays * 24 * 60 * 60 * 1000;
        const AnyRecentCreation = Items.some(
          (/** @type {any} */ ArgR) => ArgR.CreatedOn instanceof Date && ArgR.CreatedOn.getTime() >= WindowStartMs
        );
        if(AnyRecentCreation) continue;
        const AnyRecentCompletion = store
          ? store.GetLastCompletionMsForClientId(ClientId, WindowStartMs) !== null
          : false;
        if(AnyRecentCompletion) continue;
        const TaskIds = Items.map((/** @type {any} */ ArgR) => ArgR.ReminderID);
        Signals.push({
          type: 'goneQuiet',
          clientId: ClientId,
          label: `*${ClientId}* has gone quiet`,
          taskIds: TaskIds,
          details: `${Items.length} open item${Items.length === 1 ? '' : 's'}, no activity in ${QuietDays}d (task IDs: ${TaskIds.slice(0, 5).join(', ')}${TaskIds.length > 5 ? ` +${TaskIds.length - 5} more` : ''})`,
        });
      }
    }

    // 2. Deadline-window collision — fires when a client has open items AND the client's
    //    DeadlineConvention next occurrence falls within the next 48 h.
    //    Keyed off the client Defaults block, not individual reminder due dates.
    if(settings.deadlineCollision) {
      const WindowEndMs = nowMs + RemindersModule.#PROACTIVE_DEADLINE_WINDOW_MS;
      for(const [ClientId, Items] of ByClient.entries()) {
        const ClientDefaults = /** @type {{ PROACTIVE_QUIET_DAYS?: string, DeadlineConvention?: string }} */ (GetDefaults(ClientId));
        const Convention = ClientDefaults.DeadlineConvention || null;
        if(!Convention) continue;
        const NextMs = RemindersModule.ParseDeadlineConventionNextMs(Convention, nowMs);
        if(NextMs === null || NextMs < nowMs || NextMs >= WindowEndMs) continue;
        const TaskIds = Items.map((/** @type {any} */ ArgR) => ArgR.ReminderID);
        Signals.push({
          type: 'deadlineCollision',
          clientId: ClientId,
          label: `*${ClientId}* deadline convention window opens within 48 h`,
          taskIds: TaskIds,
          details: `DeadlineConvention "${Convention}" next occurrence within 48 h; ${Items.length} open item${Items.length === 1 ? '' : 's'} (task IDs: ${TaskIds.slice(0, 5).join(', ')}${TaskIds.length > 5 ? ` +${TaskIds.length - 5} more` : ''})`,
        });
      }
    }

    // 3. Aging without owner
    if(settings.agingWithoutOwner) {
      const AgingDays = workspaceInfo.PROACTIVE_AGING_DAYS != null
        ? Number(workspaceInfo.PROACTIVE_AGING_DAYS)
        : RemindersModule.#PROACTIVE_AGING_DAYS_DEFAULT;
      const AgingCutoffMs = nowMs - AgingDays * 24 * 60 * 60 * 1000;
      const UnownedAging = OpenItems.filter((/** @type {any} */ ArgR) =>
        !ArgR.AssigneeID &&
        ArgR.CreatedOn instanceof Date &&
        ArgR.CreatedOn.getTime() < AgingCutoffMs
      );
      if(UnownedAging.length > 0) {
        const TaskIds = UnownedAging.map((/** @type {any} */ ArgR) => ArgR.ReminderID);
        Signals.push({
          type: 'agingWithoutOwner',
          clientId: null,
          label: `${UnownedAging.length} unowned item${UnownedAging.length === 1 ? '' : 's'} aging beyond ${AgingDays}d`,
          taskIds: TaskIds,
          details: `No assignee; oldest items: ${TaskIds.slice(0, 5).join(', ')}${TaskIds.length > 5 ? ` +${TaskIds.length - 5} more` : ''}`,
        });
      }
    }

    Signals.sort((ArgA, ArgB) => {
      const RankA = RemindersModule.#PROACTIVE_SEVERITY[ArgA.type] ?? 99;
      const RankB = RemindersModule.#PROACTIVE_SEVERITY[ArgB.type] ?? 99;
      return RankA - RankB;
    });

    return Signals;
  }

  /**
   * Pure-function test hook: render a proactive digest section string from a pre-computed signals array.
   * Returns empty string when signals is empty (noise-budget rule: render nothing when zero signals).
   * Caps at PROACTIVE_CAP; overflow reported as "and N more".
   *
   * @param {{ type: string, clientId: string|null, label: string, taskIds: string[], details: string }[]} ArgSignals
   * @returns {string}
   */
  static RenderProactiveSection(ArgSignals) {
    if(!ArgSignals || ArgSignals.length === 0) return '';
    const Cap = RemindersModule.#PROACTIVE_CAP;
    const Shown = ArgSignals.slice(0, Cap);
    const Overflow = ArgSignals.length - Shown.length;
    const Lines = ['*Proactive signals:*'];
    for(const Signal of Shown) {
      Lines.push(`• ${Signal.label} — ${Signal.details}`);
    }
    if(Overflow > 0) {
      Lines.push(`_…and ${Overflow} more signal${Overflow === 1 ? '' : 's'}_`);
    }
    return Lines.join('\n');
  }

  // ---------------------------------------------------------------------------

  /**
   * Run the daily digest once for all users with tasks.
   * @returns {Promise<void>}
   */
  async #RunDailyTaskDigestAsync(ArgForce = false) {
    // GUARD: Prevent duplicate digests on the same calendar day.
    // Bypassed when ArgForce is true (e.g. admin "run daily digest" command).
    const TodayDateString = this.#GetTodayDateString();
    if(!ArgForce && this.#LastDailyDigestDate === TodayDateString) {
      this.#SlackApp.Logger.info(`daily digest already sent today (${TodayDateString}), skipping`);
      return;
    }

    if(ArgForce)
      this.#SlackApp.Logger.info(`daily digest force-run requested, bypassing duplicate-send guard`);


    const CurrentDayName = this.#GetCurrentDayName();
    const SnoozedToday = this.#IsSnoozedToday();

    // fast path: if today is snoozed and no reminder opts out, skip early without building user map.
    if(SnoozedToday) {
      const HasIgnoreSnoozeReminder = this.#PendingRemindersQueue.some(ArgReminder => ArgReminder.IgnoreSnooze === true);
      if(!HasIgnoreSnoozeReminder) {
        this.#SlackApp.Logger.info(
          `[snooze-guard] daily digest suppressed on ${CurrentDayName}; no IgnoreSnooze reminders available`
        );
        this.#LastDailyDigestDate = TodayDateString;
        await this.#SaveReminderCounterAsync();
        return;
      }
    }

    const ReminderChannelID = await this.#GetReminderChannelIdAsync('');
    if(!ReminderChannelID) {
      this.#SlackApp.Logger.error('could not determine reminder channel for daily digest');
      return;
    }

    let RemindersByUser = this.#BuildReminderMapByUser();
    if(RemindersByUser.size === 0) {
      this.#SlackApp.Logger.info('no reminders found for daily digest');
      // Mark as sent to prevent repeated "no reminders" checks throughout the day.
      this.#LastDailyDigestDate = TodayDateString;
      await this.#SaveReminderCounterAsync(); // IMMEDIATE PERSISTENCE
      return;
    }

    if(SnoozedToday) {
      let SuppressedReminderCount = 0;
      let AllowedReminderCount = 0;
      const FilteredRemindersByUser = new Map();

      for(const [CurrentUserID, CurrentReminders] of RemindersByUser.entries()) {
        const AllowedReminders = CurrentReminders.filter(ArgReminder => {
          const Suppressed = this.#ShouldSuppressForSnooze(ArgReminder);
          if(Suppressed) SuppressedReminderCount++;
          return !Suppressed;
        });

        if(AllowedReminders.length > 0) {
          AllowedReminderCount += AllowedReminders.length;
          FilteredRemindersByUser.set(CurrentUserID, AllowedReminders);
        }
      }

      if(FilteredRemindersByUser.size === 0) {
        this.#SlackApp.Logger.info(
          `[snooze-guard] daily digest suppressed on ${CurrentDayName}; filtered ${SuppressedReminderCount} reminders (0 allowed)`
        );
        this.#LastDailyDigestDate = TodayDateString;
        await this.#SaveReminderCounterAsync();
        return;
      }

      this.#SlackApp.Logger.info(
        `[snooze-guard] daily digest filtered on ${CurrentDayName}; filtered ${SuppressedReminderCount} reminders, posting ${AllowedReminderCount}`
      );
      RemindersByUser = FilteredRemindersByUser;
    }

    const CurrentDate = DateUtils.GetCurrentDateInTimeZone(
      this.#SlackApp.WorkspaceInfo.MAIN_TIMEZONE
    );
    const DateText = this.#FormatDailyDigestDate(CurrentDate);

    for(const [CurrentUserID, CurrentReminders] of RemindersByUser.entries()) {
      await this.#PostDailyTaskThreadAsync(ReminderChannelID, CurrentUserID, CurrentReminders, DateText);
    }

    // Post proactive signals as a standalone top-level message in the digest channel so that
    // workspace-level signals (goneQuiet / deadlineCollision / agingWithoutOwner) are not
    // buried inside one arbitrary user's personal thread.  Null thread ts = top-level post.
    // No-op when zero signals or the kill switch is off.
    await this.#PostProactiveDigestSectionAsync(ReminderChannelID, null);

    // Mark digest as sent for today and persist immediately.
    this.#LastDailyDigestDate = TodayDateString;
    this.#SlackApp.Logger.info(`daily digest sent for ${TodayDateString}`);
    await this.#SaveReminderCounterAsync(); // IMMEDIATE PERSISTENCE
  }

  /**
   * Load the reminders from disk asynchronously.
   * @returns {Promise<void>}
   */
  async #LoadRemindersAsync() {
    try {
      // assume success until proven otherwise
      this.#DataLoadError = null;

      // Clear temp files stranded beside the store by an earlier hard kill. SIGKILL cannot run
      // cleanup, so without this they would accumulate for the life of the deployment.
      await SweepStaleTempsAsync(this.#ReminderFilePath, { Logger: this.#SlackApp.Logger });

      let Parsed;
      let UsedAuthoritativeSource = true;
      try {
        const Result = await ReadWithProjectionFallbackAsync({
          flagName: 'REMINDERS_READ_SOURCE',
          Logger: this.#SlackApp.Logger,
          ReadAuthoritativeAsync: async () => {
            const RemindersJSON = await fs.readFile(this.#ReminderFilePath, 'utf8');
            // Date revival preserves the in-memory contract used by the reminder scheduler.
            return JSON.parse(RemindersJSON, (ArgKey, ArgValue) => {
              return (ArgKey === 'CreatedOn' || ArgKey === 'ShouldPostOn') ? new Date(ArgValue) : ArgValue;
            });
          },
          ReadProjectionAsync: async () => {
            if(!this.#EventStore || !this.#EventWorkspace)
              throw new Error('event ledger is not initialized');
            const Events = await this.#EventStore.readAll(this.#EventWorkspace);
            if(Events.length === 0)
              throw new Error('event ledger is empty');
            const Folded = FoldReminderReadModels(Events, { strict: true });
            return Folded.reminders.map(ArgReminder => ({
              ...ArgReminder,
              CreatedOn: ArgReminder.CreatedOn ? new Date(ArgReminder.CreatedOn) : ArgReminder.CreatedOn,
              ShouldPostOn: ArgReminder.ShouldPostOn ? new Date(ArgReminder.ShouldPostOn) : ArgReminder.ShouldPostOn,
            }));
          },
        });
        Parsed = Result.value;
        UsedAuthoritativeSource = Result.source === 'authoritative';
      } catch(parseError) {
        if(parseError && parseError.code === 'ENOENT') {
          this.#SlackApp.Logger.warn('no reminders file found, starting with an empty list.');
          this.#DataLoadError = 'file not found';
          this.#PendingRemindersQueue = [];
          this.#DataLoaded = false;
          this.#BuildReminderIndexes();
          return;
        }
        // Unparseable bytes on disk. Historically this fell through to "start with an empty list",
        // and because nothing gates saves on #DataLoaded the next ordinary save then wrote []
        // straight over the survivor data — silent, permanent loss (GH-12).
        //
        // Quarantine instead: move the bytes aside so they remain recoverable, and let the module
        // continue with an empty queue. Refusing to save at all would brick the workspace; deleting
        // would destroy the only copy. Renaming does neither.
        if(UsedAuthoritativeSource) await this.#QuarantineRemindersFileAsync(parseError);
        this.#PendingRemindersQueue = [];
        this.#DataLoaded = false;
        this.#DataLoadError = `corrupt reminders file quarantined: ${parseError.message}`;
        this.#BuildReminderIndexes();
        return;
      }

      if(Parsed !== null && !Array.isArray(Parsed)) {
        // Parsed cleanly but is not the array shape this store persists. Same reasoning as above.
        const ShapeError = new Error(`reminders file contained ${typeof Parsed}, expected an array`);
        if(UsedAuthoritativeSource) await this.#QuarantineRemindersFileAsync(ShapeError);
        this.#PendingRemindersQueue = [];
        this.#DataLoaded = false;
        this.#DataLoadError = `corrupt reminders file quarantined: ${ShapeError.message}`;
        this.#BuildReminderIndexes();
        return;
      }

      if(Array.isArray(Parsed) && Parsed.length > 0) {
        // backwards compatibility: self-update reminders missing AssigneeID or OriginalChannelName
        let UpdatedCount = 0;
        for(const reminder of Parsed) {
          let Updated = false;
          
          // Backfill assignment from legacy reminder text only when neither persisted assignment
          // field is present. Current AssigneeIDs records are authoritative and are normalized below.
          if(!reminder.AssigneeID && !Array.isArray(reminder.AssigneeIDs)
            && reminder.ReminderMessageText && reminder.OriginalSenderID) {
            const ExtractedAssigneeIDs = this.#ExtractAssigneeIDsFromReminderText(reminder.ReminderMessageText);
            if(ExtractedAssigneeIDs.length > 0) {
              reminder.AssigneeIDs = ExtractedAssigneeIDs;
              reminder.AssigneeID = ExtractedAssigneeIDs[0];
            }
            Updated = true;
          }

          // Additive disk-format migration: legacy AssigneeID-only records become a one-element
          // authoritative array; when both values exist, the valid ordered array wins and repairs
          // the compatibility mirror. The ordinary save chain persists only actual changes.
          if(this.#NormalizeReminderAssignees(reminder)) Updated = true;
          
          // Update missing OriginalChannelName (try to get it if we have access)
          if(!reminder.OriginalChannelName && reminder.OriginalChannelID) {
            const ChannelName = await this.#SlackApp.GetChannelNameAsync(reminder.OriginalChannelID);
            if(ChannelName) {
              reminder.OriginalChannelName = ChannelName;
              Updated = true;
            }
          }
          
          // FSM backfill: legacy reminders created before the State field was introduced will not have it.
          // Default to 'scheduled' since persisted reminders are always waiting for their next check cycle.
          if(!reminder.State) {
            reminder.State = RemindersModule.ReminderState.Scheduled; // FSM-BACKFILL-OK
            Updated = true;
          }

          // FSM backfill: promote legacy 'due' state to 'overdue'. 'due' was a transient in-loop marker
          // that was occasionally flushed to disk if the app shut down mid-cycle. 'overdue' is the
          // canonical persistent state as of v1.4.58.
          if(reminder.State === RemindersModule.ReminderState.Due) {
            reminder.State = RemindersModule.ReminderState.Overdue; // FSM-BACKFILL-OK
            Updated = true;
          }

          // GitHubUrls backfill: reminders created before Phase 1 of P3 (github-sync) lack the field.
          // Extract from ReminderMessageText so existing reminders benefit from auto-completion.
          if(!Array.isArray(reminder.GitHubUrls) && reminder.ReminderMessageText) {
            reminder.GitHubUrls = this.#ExtractGitHubUrls(reminder.ReminderMessageText);
            Updated = true;
          }

          // Phase A (identity stamping): resolve clientId/projectId at read time for historical
          // reminders that were created before stamping was introduced. Only resolves when the
          // field is truly absent (undefined); a stored null means "no client matched at creation"
          // and is kept as-is to avoid re-checking every load.
          if(reminder.clientId === undefined) {
            const { ClientID, ProjectID } = ResolveClientIdentity(reminder);
            reminder.clientId = ClientID;
            reminder.projectId = ProjectID;
            Updated = true;
          }

          if(Updated) UpdatedCount++;
        }

        this.#PendingRemindersQueue = Parsed;
        this.#DataLoaded = true;
        this.#DataLoadError = null;
        this.#SlackApp.Logger.info('loaded', this.#PendingRemindersQueue.length, 'reminders from file.');

        if(UpdatedCount > 0) {
          this.#SlackApp.Logger.info(`self-updated ${UpdatedCount} reminders with normalized assignees, legacy fields, State (due→overdue), or GitHubUrls`);
          // save the updated reminders back to disk
          await this.#SaveRemindersAsync();
        }
      } else {
        this.#PendingRemindersQueue = [];
        this.#DataLoaded = false;
        this.#DataLoadError = 'empty or invalid data';
        this.#SlackApp.Logger.warn('reminders file is empty or invalid, starting with empty list.');
      }

      this.#BuildReminderIndexes();
    } catch(error) {
      if(error.code === 'ENOENT') {
        this.#SlackApp.Logger.warn('no reminders file found, starting with an empty list.');
        this.#DataLoadError = 'file not found';
      } else {
        this.#SlackApp.Logger.warn('failed to read reminders file:', error);
        this.#DataLoadError = error.message;
      }
      this.#PendingRemindersQueue = [];
      this.#DataLoaded = false;
      this.#BuildReminderIndexes();
    }
  }

  /**
   * Wait for every save queued so far to reach disk.
   *
   * A durable write is roughly eight syscalls (open, write, fsync, close, rename, then the parent
   * directory) where the old `fs.writeFile` was one, so "the save has probably landed by now" is no
   * longer a safe assumption for any caller that needs to observe the file. Mirrors
   * `CompletionStore.FlushAsync`, which exists for the same reason.
   *
   * Used on shutdown so a save queued just before a restart is not dropped, and by tests that
   * assert on persisted state.
   * @returns {Promise<void>}
   */
  async FlushRemindersAsync() {
    await this.#SaveChain.catch(() => {});
  }

  /**
   * Move a corrupt reminders file aside so its bytes stay recoverable.
   *
   * Deliberately NOT called for a missing file: ENOENT is the ordinary first-run case, and a fresh
   * install must still be able to save. Only bytes that exist but cannot be trusted are quarantined.
   *
   * Never throws. If the rename fails the caller still continues with an empty queue — but the
   * error is logged loudly, because in that case the next save WILL overwrite the corrupt file and
   * the original bytes are genuinely lost.
   * @param {Error} ArgCause Parse or shape error that triggered the quarantine.
   * @returns {Promise<string|null>} Quarantine path, or null when the rename failed.
   */
  async #QuarantineRemindersFileAsync(ArgCause) {
    const Stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const QuarantinePath = `${this.#ReminderFilePath}.corrupt-${Stamp}`;
    try {
      await fs.rename(this.#ReminderFilePath, QuarantinePath);
      this.#SlackApp.Logger.error(
        `reminders file was unreadable (${ArgCause.message}) and has been quarantined to ${QuarantinePath}. ` +
        'Starting with an empty queue; the original bytes are preserved for recovery.'
      );
      return QuarantinePath;
    } catch(renameError) {
      this.#SlackApp.Logger.error(
        `reminders file was unreadable (${ArgCause.message}) and could NOT be quarantined:`, renameError,
        '— the next save will overwrite it and the original bytes will be lost.'
      );
      return null;
    }
  }

  /**
   * Save the reminders to disk asynchronously.
   *
   * Queues the save behind any in-flight one (#SaveChain) so concurrent callers cannot lose an
   * update. Both the snapshot and the write happen inside the chain: snapshotting outside it would
   * reintroduce the very race the chain exists to close, since a caller could serialize the queue,
   * wait its turn, and then persist a view of the world that a save in between has already
   * superseded.
   *
   * Callers keep the existing contract — the returned promise rejects on write failure — so the
   * awaiting call sites still surface errors exactly as before.
   * @returns {Promise<void>}
   */
  #SaveRemindersAsync() {
    this.#SaveChain = this.#SaveChain
      .catch(() => {})            // a failed save must not poison later ones
      .then(() => this.#PersistRemindersAsync());
    return this.#SaveChain;
  }

  /**
   * Serialize and durably persist the reminder queue. Only ever called from inside #SaveChain.
   * @returns {Promise<void>}
   */
  async #PersistRemindersAsync() {
    try {
      if(!this.#ReminderFilePath) {
        this.#SlackApp.Logger.warn("skipping reminder save because reminder file path is not initialized.");
        return;
      }

      // convert the reminders queue to a JSON string.
      const RemindersJSON = JSON.stringify(this.#PendingRemindersQueue, null, 2);

      // Crash-atomic write (GH-12): temp -> fsync -> rename -> fsync dir. A hard kill mid-write can
      // no longer truncate this file, which previously degraded to an empty queue on the next boot
      // and was then made permanent by the next ordinary save.
      await WriteFileDurableAsync(this.#ReminderFilePath, RemindersJSON, { Logger: this.#SlackApp.Logger });
      this.#SlackApp.Logger.info("saved", this.#PendingRemindersQueue.length, "reminders to file.");
    } catch(error) {
      // TODO: should we just log the error without rethrowing since reminders are saved frequently?
      this.#SlackApp.Logger.error("failed to save reminders file:", error);
      throw error;
    }
  }

  /**
   * Append one false-positive training example to the workspace JSONL file.
   *
   * Appending confines any torn write to the final record instead of damaging earlier entries, and
   * the fsync (GH-12) means an acknowledged example is on disk before this resolves. Both matter
   * here: an example is unreconstructable user feedback (someone explicitly trashed a reminder),
   * and `#RunWeeklyTrashedExamplesReportAsync` advances a durable cursor past it — so a lost or
   * torn line is skipped forever rather than retried. The ~5.7 ms fsync is irrelevant at this
   * call rate (a handful of trash reactions per day).
   * @param {Object} ArgExample Structured example object from RemindersReactionHandler.
   * @returns {Promise<void>}
   */
  async #SaveTrashedExampleAsync(ArgExample) {
    if(!this.#TrashedExamplesFilePath) return;
    try {
      await AppendFileDurableAsync(this.#TrashedExamplesFilePath, JSON.stringify(ArgExample) + '\n');
    } catch(error) {
      this.#SlackApp.Logger.warn('trashed-example: failed to append to examples file (non-fatal):', error);
    }
  }

  /**
   * Advance a reminder's due date to the next day that is not a snooze day (workspace timezone).
   * Mutates ArgShouldPostOn in place. Used when today is a snooze day so reminders skip to the next posting day
   * (e.g. Saturday -> Monday when SNOOZE_DAYS is Saturday and Sunday).
   * @param {Date} ArgShouldPostOn Reminder due date (localized to workspace timezone).
   */
  #AdvanceToNextNonSnoozeDay(ArgShouldPostOn) {
    if(this.#SnoozeDays.size === 0) {
      ArgShouldPostOn.setUTCDate(ArgShouldPostOn.getUTCDate() + 1);
      return;
    }
    const DayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for(let i = 0; i < 7; i++) {
      ArgShouldPostOn.setUTCDate(ArgShouldPostOn.getUTCDate() + 1);
      const Localized = DateUtils.GetLocalizedUtcDate(
        this.#SlackApp.WorkspaceInfo.MAIN_TIMEZONE,
        ArgShouldPostOn
      );
      const DayName = DayNames[Localized.getUTCDay()];
      if(!this.#SnoozeDays.has(DayName)) return;
    }
  }

  /**
   * Get current day name in workspace timezone.
   * @returns {string}
   */
  #GetCurrentDayName() {
    const CurrentDate = DateUtils.GetCurrentDateInTimeZone(
      this.#SlackApp.WorkspaceInfo.MAIN_TIMEZONE
    );

    // NOTE: CurrentDate's UTC values already represent local workspace time.
    // Do NOT apply timezone conversion again here.
    const DayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return DayNames[CurrentDate.getUTCDay()];
  }

  /**
   * Determine whether today is a configured snooze day.
   * @returns {boolean}
   */
  #IsSnoozedToday() {
    if(this.#SnoozeDays.size === 0) return false;
    return this.#SnoozeDays.has(this.#GetCurrentDayName());
  }

  /**
   * Determine whether a reminder should be suppressed by snooze policy.
   * @param {ReminderInfo} ArgReminder Reminder being evaluated.
   * @param {boolean} [ArgForceOverride] Ignore snooze rules when true.
   * @returns {boolean}
   */
  #ShouldSuppressForSnooze(ArgReminder, ArgForceOverride = false) {
    if(ArgForceOverride) return false;
    return this.#IsSnoozedToday() && ArgReminder.IgnoreSnooze !== true;
  }

  /**
   * Check for pending reminders that are due and post them to Slack.
   *
   * Runs two sequential passes every cycle:
   *   Pass 1 (Mark): scheduled/failed reminders past their due time → overdue. No Slack I/O.
   *   Pass 2 (Post): overdue reminders meeting the auto-post threshold → posting.
   *     Reminders overdue by more than 24h accumulate in 'overdue' for display in "show my
   *     reminders" past-due buckets without flooding Slack on app restart.
   * @returns {Promise<void>}
   */
  async #CheckRemindersAsync(ArgForceProcessAll = false) {
    // get the current date and time used to check for reminders that need to be posted.
    const CurrentDateTime = new Date();

    // determine if reminders should be skipped today.
    const CurrentDayName = this.#GetCurrentDayName();
    const SnoozedToday = this.#IsSnoozedToday();
    this.#SlackApp.Logger.info(`[snooze-check] today=${CurrentDayName} snoozed=${SnoozedToday}`);

    // ── PASS 1: MARK ─────────────────────────────────────────────────────────────────────────────
    // Transition scheduled/failed reminders that are past-due to 'overdue'. No Slack I/O in this pass.
    // Retry-eligible reminder IDs (those transitioning from 'failed') are tracked so the post pass
    // always includes them regardless of the auto-post age threshold.
    const RetryEligibleIDs = /** @type {Set<string>} */(new Set());
    let MarkPassChanged = false;

    for(const Reminder of this.#PendingRemindersQueue) {
      const IsDue = ArgForceProcessAll || CurrentDateTime >= Reminder.ShouldPostOn;

      if(Reminder.State === RemindersModule.ReminderState.Failed && IsDue) {
        RetryEligibleIDs.add(Reminder.ReminderID);
        this.#TransitionReminderState(Reminder, RemindersModule.ReminderState.Overdue, 'retry');
        MarkPassChanged = true;
      } else if(Reminder.State === RemindersModule.ReminderState.Scheduled && IsDue) {
        this.#TransitionReminderState(
          Reminder,
          RemindersModule.ReminderState.Overdue,
          ArgForceProcessAll ? 'force-process-all' : 'time-reached'
        );
        MarkPassChanged = true;
      }
    }

    // ── PASS 2: POST ─────────────────────────────────────────────────────────────────────────────
    // Collect overdue reminders that meet the posting criteria.
    // Auto-post threshold: 24 hours. Reminders overdue by more than 24h accumulate in 'overdue'
    // (visible in "show my reminders" past-due buckets) without flooding Slack on restart.
    const AutoPostThresholdMs = 24 * 60 * 60 * 1000; // 24 hours in milliseconds.

    const RemindersToPost = this.#PendingRemindersQueue.filter(ArgReminder => {
      if(ArgReminder.State !== RemindersModule.ReminderState.Overdue) return false;
      if(RetryEligibleIDs.has(ArgReminder.ReminderID)) return true; // retry-eligible: always post.
      if(ArgForceProcessAll) return true;                            // force mode: bypass age threshold.
      const OverdueByMs = CurrentDateTime.getTime() - ArgReminder.ShouldPostOn.getTime();
      return OverdueByMs <= AutoPostThresholdMs;
    });

    // exit early if nothing to post (persist mark-pass state changes if any occurred).
    if(RemindersToPost.length === 0) {
      if(MarkPassChanged) await this.#SaveRemindersAsync();
      return;
    }

    // reset the reminder counter every day.
    {
      // TODO: this is hardcoded to 15:00 UTC == 8:00 AM PST. It needs to respect the configured time zone.
      // compute the date and time when the counter should be reset today.
      const TargetCounterResetDate = new Date();
      TargetCounterResetDate.setUTCHours(15, 0, 0, 0);

      // determine if the last reset was yesterday.
      const MillisecsSinceLastReset = CurrentDateTime.getTime() - this.#ReminderCounterLastReset.getTime();
      const LastResetWasYesterday = MillisecsSinceLastReset >= (24 * 60 * 60 * 1000); // 24 hours in milliseconds.

      // determine if we should reset the counter using the following conditions:
      // - the current date and time is ON OR AFTER the reset date (i.e. it is time to reset the counter).
      // - the last reset was yesterday (this avoids resetting the counter multiple times in the same day).
      // if both conditions are met, reset the counter to 1 and update the last reset date. NOTE: we don't
      // use the current date and time as the last reset date since it may be much later in the day if the
      // app was restarted later in the day; using such a delayed reset date would cause the counter to
      // reset at the wrong time the next day.
      if(CurrentDateTime >= TargetCounterResetDate && LastResetWasYesterday) {
        this.#ReminderCounter = 1;
        this.#ReminderCounterLastReset = TargetCounterResetDate;
        this.#SlackApp.Logger.info("reset reminder counter to 1. Next reset date:", this.#ReminderCounterLastReset);
      }
    }

    // track reminders that failed to post due to bot not being a channel member. NOTE: we saw this happen
    // when the bot was removed from a channel while one or more reminders were pending; without deleting the
    // reminders, the bot would keep trying to post them in the channel and failing indefinitely.
    const RemindersToDeleteByID = /** @type {Set<string>} */(new Set());

    // post the reminders and update the queue.
    // FSM: every reminder entering this loop must exit with a transition. The expected paths are:
    //   snoozed today  →  overdue → snoozed → scheduled (continue)
    //   post success   →  overdue → posting → posted → rescheduled → scheduled
    //   post failure   →  overdue → posting → failed (will retry next cycle)
    //   bot not member →  overdue → posting → dead-letter (terminal, deleted)
    // If you add a new exit path from this loop, add a corresponding #TransitionReminderState call.
    for(const ReminderToPost of RemindersToPost) {
      if(this.#ShouldSuppressForSnooze(ReminderToPost, ArgForceProcessAll)) {
        this.#TransitionReminderState(ReminderToPost, RemindersModule.ReminderState.Snoozed, 'snooze-day');
        this.#AdvanceToNextNonSnoozeDay(ReminderToPost.ShouldPostOn);
        this.#TransitionReminderState(ReminderToPost, RemindersModule.ReminderState.Scheduled, 'snooze-advanced');
        this.#SlackApp.Logger.info(
          `[snooze-guard] reminder ${ReminderToPost.ReminderID} snoozed on ${CurrentDayName} to ${ReminderToPost.ShouldPostOn}`
        );
        continue;
      }
      this.#TransitionReminderState(ReminderToPost, RemindersModule.ReminderState.Posting, 'overdue-for-posting');

      // we need a counter to track the number of times the reminder was posted successfully in different channels. This
      // will ultimately help us mark the reminder as posted successfully; it is necessary because the logic that posts
      // the reminder in different channels may fail in one channel but succeed in another.
      let ReminderPostedCounter = 0;

      // save these for easier access when writing logs below.
      const ReminderID = ReminderToPost.ReminderID;
      const TargetChannelID = ReminderToPost.TargetChannelID;
      const OriginalChannelID = ReminderToPost.OriginalChannelID;

      // Build the compact text using the shared helper function
      const CompactText = await BuildCompactTextForReminder(
        this.#SlackApp,
        ReminderToPost,
        GetAlphabeticalLabel(this.#ReminderCounter)
      );

      // Create metadata for the reminder message. NOTE: we use an array of reminder IDs even though we are only posting
      // one reminder at a time. This is done for consistency with the feedback message which uses metadata with multiple
      // reminder IDs and allows us to use the same code for deleting reminders that are either completed or canceled.
      const MessageMetadata = /** @type {import('./slack-app').MessageMetadata} */({
        event_type: 'sleuth-ai-reminder-ids',
        event_payload: {
          ReminderIDs: JSON.stringify([ReminderToPost.ReminderID])
        }
      });

      // determine if the original channel is a test channel (i.e. contains the word "test" in the name). To reduce noise
      // if a message is posted in a test channel, we do not post reminders for it in the target channel later below.
      let OriginalChannelIsTest = false;
      {
        // get the channel name for the original channel.
        const OriginalChannelName = await this.#SlackApp.GetChannelNameAsync(OriginalChannelID);

        // check if the channel name contains the word "test". If the channel name could not be retrieved, we assume
        // it is NOT a test channel and the reminder will be posted in the target channel like normal.
        OriginalChannelIsTest = OriginalChannelName && OriginalChannelName.toLowerCase().includes("test");

        // if the original channel is a test channel, log a message to indicate that the reminder will not be posted
        // in the target channel to avoid duplicate messages in the test channel.
        if(OriginalChannelIsTest)
          this.#SlackApp.Logger.info(`test reminder ${ReminderID} will NOT be posted in target channel.`);
      }

      // if the original channel is not a test channel (or does not exist, which may be the case for very old reminders
      // where the original channel was not stored), post the reminder in the target channel as usual.
      if(!OriginalChannelIsTest) {
        try {
          // post the compact reminder message to the target channel.
          await this.#SlackApp.PostMessageTextAsync(
            TargetChannelID,
            undefined,
            CompactText,
            MessageMetadata,
            { Tag: 'reminder-delivery-target' }
          );

          // update the reminder status.
          ReminderPostedCounter++;
          this.#SlackApp.Logger.info(`posted reminder ${ReminderID} in target channel ${TargetChannelID}`);
        } catch {
          // log the error message to indicate that the reminder could not be posted in the target channel.
          this.#SlackApp.Logger.error(`failed to post reminder ${ReminderID} in target channel ${TargetChannelID}`);

          // mark the reminder for deletion if posting failed due to the bot not being a member of the target channel.
          if(await this.#SlackApp.IsChannelMemberAsync(TargetChannelID) === false) {
            this.#SlackApp.Logger.info(
              `bot is not a member of target channel ${TargetChannelID}, marking reminder ${ReminderID} for deletion`
            );
            RemindersToDeleteByID.add(ReminderID);
          }
        }
      }

      // post the reminder message to the original channel if different from the target channel.
      if(OriginalChannelID !== TargetChannelID) {
        try {
          // post the compact reminder message to the original channel.
          await this.#SlackApp.PostMessageTextAsync(
            OriginalChannelID,
            undefined,
            CompactText,
            MessageMetadata,
            { Tag: 'reminder-delivery-origin' }
          );

          // update the reminder status.
          ReminderPostedCounter++;
          this.#SlackApp.Logger.info(`posted reminder ${ReminderID} in original channel ${OriginalChannelID}`);
        } catch {
          // log the error message to indicate that the reminder could not be posted in the original channel.
          this.#SlackApp.Logger.error(`failed to post reminder ${ReminderID} in original channel ${OriginalChannelID}`);

          // mark the reminder for deletion if posting failed due to the bot not being a member of the original channel.
          if(await this.#SlackApp.IsChannelMemberAsync(OriginalChannelID) === false) {
            this.#SlackApp.Logger.info(
              `bot is not a member of original channel ${OriginalChannelID}, marking reminder ${ReminderID} for deletion`
            );
            RemindersToDeleteByID.add(ReminderID);
          }
        }
      }

      // if reminder was posted successfully in at least one channel and isn't marked for deletion, then reschedule it
      // for the next day. NOTE: if the bot was not a member of one of the channels, we don't want to reschedule the
      // reminder since attempting to post it again will fail for that channel and end up polluting the logs with errors.
      if(ReminderPostedCounter > 0 && !RemindersToDeleteByID.has(ReminderID)) {
        this.#TransitionReminderState(ReminderToPost, RemindersModule.ReminderState.Posted, 'posted-to-channel');

        if(this.#ListsModule && this.#ListsModule.IsListsAvailable) {
          try {
            await this.#ListsModule.MarkReminderPostedAsync(ReminderID);
          } catch(error) {
            this.#SlackApp.Logger.warn(`failed to update Slack List status for posted reminder ${ReminderID}: ${error.message}`);
          }
        }

        // increment reminder counter. This is only done if the reminder was posted successfully in at least
        // one channel to avoid incrementing the counter for failed reminders.
        this.#ReminderCounter++;

        // push the due date out to tomorrow (relative to now), preserving the original posting time (HH:MM).
        // advancing by just +1 day from the stored date caused a cascade loop: if the reminder was many days
        // overdue, each 30-second check cycle would fire it again (new date still in the past) until every
        // missed day had been cycled through, flooding Slack with duplicate posts.
        // by jumping directly to tomorrow we guarantee the rescheduled date is always in the future regardless
        // of how stale the original due date was.
        const NextPostDate = new Date();
        NextPostDate.setUTCDate(NextPostDate.getUTCDate() + 1);
        NextPostDate.setUTCHours(
          ReminderToPost.ShouldPostOn.getUTCHours(),
          ReminderToPost.ShouldPostOn.getUTCMinutes(),
          0, 0
        );
        ReminderToPost.ShouldPostOn = NextPostDate;
        ReminderToPost.IgnoreSnooze = false;
        this.#TransitionReminderState(ReminderToPost, RemindersModule.ReminderState.Rescheduled, 'next-day');
        this.#TransitionReminderState(ReminderToPost, RemindersModule.ReminderState.Scheduled, 'waiting-next-cycle');

        // indicate that the reminder was rescheduled (helpful for debugging without having to wait for the next day).
        this.#SlackApp.Logger.info(`rescheduled reminder ${ReminderID} for ${ReminderToPost.ShouldPostOn}`);
      } else if(ReminderPostedCounter === 0 && !RemindersToDeleteByID.has(ReminderID)) {
        // both channel posts failed but the bot is still a member — mark as failed so persisted state
        // isn't stuck at 'posting'. The reminder will be retried on the next check cycle.
        this.#TransitionReminderState(ReminderToPost, RemindersModule.ReminderState.Failed, 'all-posts-failed-will-retry');
      }
    }

    // delete reminders targeting channels where the bot is not a member. NOTE: the call to #DeleteRemindersAsync()
    // below will also save the updated reminders to disk which is why we only call #SaveRemindersAsync() if there are
    // no reminders to delete; without this check, we would end up saving the reminders to disk twice which is harmless
    // but inefficient.
    if(RemindersToDeleteByID.size > 0) {
      for(const ReminderID of RemindersToDeleteByID) {
        const ReminderToDelete = this.#PendingRemindersQueue.find(ArgReminder => ArgReminder.ReminderID === ReminderID);
        if(ReminderToDelete)
          this.#TransitionReminderState(ReminderToDelete, RemindersModule.ReminderState.DeadLetter, 'terminal: bot-not-channel-member');
      }

      this.#SlackApp.Logger.info(
        `deleting ${RemindersToDeleteByID.size} reminders due to bot not being channel member`
      );
      await this.#DeleteRemindersAsync([...RemindersToDeleteByID], 'dead-letter');
    } else {
      // save the updated reminders to disk.
      await this.#SaveRemindersAsync();
    }
  }

  /**
   * Persist a new reminder into the in-memory queue and all lookup indexes — the FSM write gate.
   *
   * Do not call this method directly with a manually-constructed object. All callers must build
   * ArgReminderInfo through #MakeScheduledReminder(), which enforces the FSM entry invariants
   * (State=Scheduled, IgnoreSnooze=false, fresh ReminderID/CreatedOn). After creation, state
   * changes must go through #TransitionReminderState() — never by assigning reminder.State
   * directly.
   *
   * Approved callers:
   *   #TryScheduleRemindersAsync — AI-driven auto-scheduling and manual/forced scheduling
   *   CreateReminderFromListRowAsync — list-sync path (skips AI, uses authored row data)
   *
   * @param {ReminderInfo} ArgReminderInfo Reminder to queue.
   * @param {{ SkipListSync?: boolean }} [ArgOptions] When SkipListSync is true, the reminder is
   *   not fanned out to Slack Lists here — used when the reminder originated from a list row,
   *   so the caller can adopt the existing row instead of creating a duplicate.
   */
  async #QueueReminderAsync(ArgReminderInfo, ArgOptions = {}) {
    this.#NormalizeReminderAssignees(ArgReminderInfo);

    // add the reminder to the queue.
    this.#PendingRemindersQueue.push(ArgReminderInfo);

    // update sender index with the new reminder.
    const SenderList = this.#RemindersBySender.get(ArgReminderInfo.OriginalSenderID) ?? [];
    SenderList.push(ArgReminderInfo);
    this.#RemindersBySender.set(ArgReminderInfo.OriginalSenderID, SenderList);

    // Index the one shared record once for every assignee. The normalized helper excludes bot IDs
    // and preserves the sender fallback for malformed legacy records.
    for(const AssigneeID of RemindersModule.GetAssigneeIDs(ArgReminderInfo, this.#SlackApp.BotUserID)) {
      const AssigneeList = this.#RemindersByAssignee.get(AssigneeID) ?? [];
      AssigneeList.push(ArgReminderInfo);
      this.#RemindersByAssignee.set(AssigneeID, AssigneeList);
    }

    // save the updated reminders to disk.
    await this.#SaveRemindersAsync();

    // add reminder to Slack List if available (unless the caller is adopting an existing row).
    if(!ArgOptions.SkipListSync && this.#ListsModule && this.#ListsModule.IsListsAvailable) {
      await this.#ListsModule.AddReminderToListAsync(ArgReminderInfo);
    }

    // log the reminder details.
    this.#SlackApp.Logger.info(
      `queued reminder ${ArgReminderInfo.ReminderID} for ${ArgReminderInfo.ShouldPostOn.toUTCString()}`
    );
  }

  /**
   * Delete reminders from queue by ID and fan the lifecycle change out to Slack Lists.
   * @param {string[]} ArgReminderIDs Array of reminder IDs to delete.
   * @param {'completed'|'canceled'|'dead-letter'|string} [ArgReason] Why the reminders are
   *   being removed. 'completed' keeps the per-user list row as a history record; any other
   *   reason deletes the row.
   * @returns {Promise<void>}
   */
  async #DeleteRemindersAsync(ArgReminderIDs, ArgReason = 'canceled') {
    // convert reminder IDs array to a Set for faster lookups.
    const ReminderIDSet = new Set(ArgReminderIDs);

    // keep only the reminders that are NOT in the set of reminder IDs to delete.
    this.#PendingRemindersQueue = this.#PendingRemindersQueue.filter(
      ArgReminder => !ReminderIDSet.has(ArgReminder.ReminderID)
    );

    // rebuild indexes to reflect the deleted reminders.
    this.#BuildReminderIndexes();

    // save the updated reminders to disk.
    await this.#SaveRemindersAsync();

    // fan the lifecycle change out to Slack Lists if available.
    if(this.#ListsModule && this.#ListsModule.IsListsAvailable) {
      for(const ReminderID of ArgReminderIDs) {
        if(ArgReason === 'completed') {
          await this.#ListsModule.HandleReminderCompletedAsync(ReminderID);
        } else {
          await this.#ListsModule.HandleReminderRemovedAsync(ReminderID, ArgReason);
        }
      }
    }
  }

  /**
   * Build in-memory indexes for quick reminder lookups.
   */
  #BuildReminderIndexes() {
    // reset both indexes and repopulate from queue.
    this.#RemindersBySender = new Map();
    this.#RemindersByAssignee = new Map();

    for (const reminder of this.#PendingRemindersQueue) {
      const SenderList = this.#RemindersBySender.get(reminder.OriginalSenderID) ?? [];
      SenderList.push(reminder);
      this.#RemindersBySender.set(reminder.OriginalSenderID, SenderList);

      for(const AssigneeID of RemindersModule.GetAssigneeIDs(reminder, this.#SlackApp.BotUserID)) {
        const AssigneeList = this.#RemindersByAssignee.get(AssigneeID) ?? [];
        AssigneeList.push(reminder);
        this.#RemindersByAssignee.set(AssigneeID, AssigneeList);
      }
    }
  }


  /**
   * Save the reminder counter state to disk asynchronously.
   * Persists ReminderCounter, ReminderCounterLastReset, and LastDailyDigestDate.
   * Called immediately after operations to ensure durability.
   * @returns {Promise<void>}
   */
  async #SaveReminderCounterAsync() {
    try {
      if(!this.#ReminderCounterFilePath || !this.#ReminderCounterLastReset) {
        this.#SlackApp.Logger.warn("skipping reminder counter save because counter state is not initialized.");
        return;
      }

      const ReminderCounterData = JSON.stringify({
        ReminderCounter: this.#ReminderCounter,
        ReminderCounterLastReset: this.#ReminderCounterLastReset.toISOString(),
        LastDailyDigestDate: this.#LastDailyDigestDate,
      });

      // Crash-atomic (GH-12): a truncated counter file would fail to parse on the next boot and
      // reset the daily-digest cursor, re-sending a digest that already went out.
      await WriteFileDurableAsync(this.#ReminderCounterFilePath, ReminderCounterData, { Logger: this.#SlackApp.Logger });
      this.#SlackApp.Logger.info("saved reminder counter to file:", this.#ReminderCounterFilePath);
    } catch(error) {
      this.#SlackApp.Logger.error("failed to save reminder counter to file:", error);
      // Don't throw - allow operation to continue even if save fails
    }
  }



}

// export the class.
module.exports = RemindersModule;
