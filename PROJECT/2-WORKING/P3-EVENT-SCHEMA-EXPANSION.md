---
title: P3 — Event Schema Expansion (make the ledger sufficient to reconstruct state)
created: 2026-08-08
updated: 2026-08-08
branch: development
status: Phases A and B implemented and green; C is half done (field gate yes, generation checkpoint no); D not started
owner: noel
author: Claude (Opus 5, 1M)
doc_type: proposal
complexity: 3
risk: 3
effort: 3
phases: 4
related:
  - PROJECT/2-WORKING/P3-EVENT-SOURCED-CORE.md — the parent plan this unblocks
  - RELEASES.md -> Release 1.5.0 "Ledger"
  - PROJECT/3-COMPLETED/GH-355-P3-BASELINE-IMPORT.md — the precedent spike
goal: >
  Make the append-only event log carry enough to reconstruct a ReminderInfo byte-for-byte, so the
  read cutovers and boot-time rebuild that are currently blocked can be proven lossless rather than
  assumed.
---

# P3 — Event Schema Expansion

## Status

| What was just completed | What's next |
|---|---|
| **Phases A and B implemented and green** (3 commits, gate: 98 suites / 1572 Jest, 73 `node --test`, build 0, `validate:fsm` OK). Schema v2 is written and validated per-event-version; every transition is emitted; relay state is evented thread-scoped; the fold reproduces all of it; `--enrich` repairs a pre-v2 stream. **Phase C is HALF done**: the field-level gate rejects a stream missing what v2 added, but the generation-aware checkpoint is not started. | **The generation checkpoint, then Phase D — a parity run on real workspace data.** No flag unblocks without D. `COMPLETED_READ_SOURCE` and `REBALANCE_EXPORT_SOURCE` now wait only on that run. `REMINDERS_READ_SOURCE` waits on the checkpoint too — it is blocked on detecting a short ledger, which no schema field can do. |

## Why this exists, and the process lesson

**A version of this spike was already run, and its success was over-generalized.**
`scripts/summarize-week-shadow-diff.js` folded real prod `neochrome` data for one projection, found
11 mismatches, and GH-355 drove them to 0. From that, the plan concluded *"the substrate is proven"*.

But `summarize-week` needs a thin slice — completion timestamps and assignees. Nobody re-ran the
same diff asking the harder question: **can a full `ReminderInfo` be reconstructed from the log?**
That question is answerable in about a day with tooling that already exists, and answering it would
have surfaced every blocker below before eight marathon phases were planned around the assumption.

**Adopted as a rule for this plan:** a phase that asserts parity must run its own diff against real
data before being scheduled, not inherit a neighbouring phase's result.

## The gaps, measured

Each is verified in source, not inferred.

### 1. `ReminderCreated` omits reconstruction fields

`REQUIRED_PAYLOAD_KEYS.ReminderCreated` (`src/event-store.js:39`) is
`['text', 'assigneeId', 'sourceChannelId', 'targetChannelId', 'source', 'githubUrls']`.

A persisted `ReminderInfo` additionally carries, and the fold cannot restore:

| Field | Consequence if unrestored |
|---|---|
| `CreatedOn` | `Event.ts` is stamped when the *append* runs, not when the reminder was created — substituting it changes raw JSON bytes |
| `OriginalSenderID` | sender attribution lost |
| `OriginalMessageID` | **thread dedupe breaks** — this is the identity GH-27 keys on |
| `OriginalThreadTs` | same; thread identity is `OriginalThreadTs ?? OriginalMessageID` |
| `OriginalChannelName` | display regressions in digests |
| `IgnoreSnooze` | snooze behaviour changes (`src/reminders-module.js:3204-3206`) |

### 2. Relay state is never evented at all

`GitHubRelayStarted` / `GitHubRelayStopped` are persisted `ReminderInfo` fields
(`src/reminders-module.js:87-88`). No event payload carries them, **and** relay stop/start mutates
and saves JSON directly with no lifecycle event (`src/github-comment-relay.js:110-116`, `:170-176`).

This is the sharpest one because it is behavioural, not cosmetic: `github-comment-relay.js:102`
refuses to relay when `GitHubRelayStopped` is set, so a flag-on read from a stream lacking it
**resumes a relay a user deliberately stopped**, and `:143` treats an already-started relay as
first-use, posting a duplicate permalink.

### 3. Most lifecycle transitions are never emitted

`#EmitTransitionEvent` (`src/reminders-module.js:489-511`) maps only `Scheduled`, `Completed`,
`Snoozed`, `Cancelled`. Its own comment names the rest as deliberately unemitted: `due`, `overdue`,
`posting`, `posted`, `rescheduled`, `failed`, `dead-letter`.

Consequence: a fold cannot reproduce in-memory state for active reminders even when every creation
event is present, because the states they passed through left no trace.

### 4. Rescheduling silently resets `IgnoreSnooze`

The live queue sets `IgnoreSnooze = false` before scheduling (`src/reminders-module.js:3455-3458`),
but `ReminderScheduled` persists only `dueAt` / `via` (`:489-505`). The fold keeps the stale value
and the rebalance export publishes it **to an external consumer** (`src/web-api.js:459-466`).

### 5. `ReminderCompleted` cannot reproduce a completion record

It carries `by`, `method`, `summary`, `completedAt`. The authoritative `CompletionRecord` also needs
`sourceChannelID`, `dueDate`, `clientId` — and critically, its `completedMs` is stamped with
`Date.now()` (`src/reminders-module.js:569-576`) while the event carries a **separately sampled**
ISO instant (`:496-502`). Two different clock reads; they can never be byte-identical.

### 6. `readAll()` cannot signal a read failure

`src/event-store.js:223-254` collapses every read error — missing file, torn line, permission — to
`[]`. A caller cannot distinguish "no events" from "could not read events", so the reversibility
contract's required warn-and-fall-back **cannot fire**. An empty read currently looks like a valid
empty workspace.

### 7. Appends are best-effort, so a ledger can be valid but short

`#EmitLifecycleEvent` is fire-and-forget and tolerates `{ ok: false }`
(`src/reminders-module.js:516-555`). A torn append leaves a stream that passes every field check
while missing an event. Strict parity cannot detect a *lost* event among valid ones — a lone
creation passes while its absent paired `ReminderScheduled` leaves `ShouldPostOn` null.

## What this proposal does NOT do

- **It does not flip any flag.** Every projection flag stays in `BLOCKED_PROJECTION_FLAGS` until its
  own parity run passes on real data. This proposal makes that run *possible*, not automatic.
- **It does not change user-visible behaviour.** It widens what is written to the log and adds a
  read-error signal. The authoritative JSON path is untouched.
- **It does not attempt Phase 4, 6a, or the drill.** Those resume after this lands and their parity
  is proven.

## Cross-model review, 2026-08-08

Consulted Codex and agy. **agy timed out at the 300s cap, so this is a single-model review — the
harness stamped it `SINGLE-MODEL — NOT RECONCILED` and none of it is cross-verified.** A second pass
with agy is queued.

Codex's verdict was *"the right append-only approach, but this proposal is not ready as described."*
Seven findings, all source-grounded. Two I verified myself before accepting:

- **`hasOwnProperty` is not presence.** `event-store.js:68` checks
  `Object.prototype.hasOwnProperty.call(Payload, Key)`, which is **true for a property whose value is
  `undefined`** — and `JSON.stringify` then drops it. An event can pass validation and be written with
  the key absent from the serialized line. The whole "required key" guarantee this proposal leans on
  has a hole in it. **Verified by reading the validator.**
- **The baseline importer cannot enrich the records that need it.** `BuildSeededReminderIdSet`
  (`scripts/baseline-import.js:192`) collects every ID that already has a `ReminderCreated` or
  `BaselineReminderImported` event and skips it — so it can never upgrade existing v1 history.
  **Verified by reading the function.**

The plan below is the revised one. What changed and why is recorded inline.

## Second opinion — agy, 2026-08-08 (now genuinely cross-model)

agy answered on the retry and **disagreed with Codex on three of five points**, which is the value of
asking two models. Recorded with my adjudication, since silently picking a winner would hide the
disagreement from the next reader.

### agy's blocker: `AssigneeIDs` and `clientId` are missing from Phase A

**Accepted — this is the fifth-phase gap I asked for.** `src/reminders-module.js:84-85` marks
`AssigneeIDs` (array) as *"Authoritative ordered, de-duplicated human Slack user IDs"* and
`AssigneeID` (scalar) as a *"Deprecated compatibility mirror of the first AssigneeIDs entry"*. The
event schema requires only the scalar. My Phase A omitted both fields entirely.

This matters especially because **GH-22 shipped multi-assignee support this morning** (PR #29). A
schema that guarantees only the scalar would let the ledger quietly undo that feature.

**One correction to agy's stated consequence, from checking:** the fold does *not* currently drop
multi-assignee data in the queue path — `reminders-module.js:623` emits `assigneeIds` and
`reminders-projection.js:219` reads it back. The real exposure is narrower and subtler: the field is
**emitted but not required**, so nothing validates it, and combined with the `hasOwnProperty`/
`undefined` hole above an event could be written with the key dropped and still pass every check.

**And a third thing neither model raised, found while verifying:** `BuildProjectedRebalanceExport`
(`src/reminders-projection.js:365`) projects only the scalar `assigneeId` — but so does the
authoritative export. `assigneeIds` appears in **no** export path. So this is not a parity break; it
is a shared blind spot, and **GH-22's multi-assignee data never reached the rebalance export at all**.
Logged as a separate follow-up, not folded into this proposal.

### Disagreement 1 — Phase C's parity gate

- **Codex:** generation-aware dirty/clean gate; a periodic check can go stale immediately because
  appends are fire-and-forget.
- **agy:** *"textbook over-engineering"* — entangling the legacy authoritative mutation path with a
  synchronous gate defeats the strangler pattern. Prefers a `ParityCheckpoint` event or sequence-number
  comparison.

**Adjudication: agy's mechanism, Codex's strictness.** agy is right that wiring cache invalidation
into the legacy JSON mutation cycle is the wrong place to put this — that path is what we are trying
to *retire*, not extend. Codex is right that staleness must be detectable at read time, not merely
periodically. Phase C therefore uses **sequence/append-count comparison at read time**: cheap, no
mutation-path entanglement, and it detects a short ledger because a dropped append leaves the count
behind. If that proves insufficient in Phase D's real-data run, the generation gate returns as a
documented fallback rather than being built speculatively.

### Disagreement 2 — versioning strictness

- **Codex:** closed `(version, type)` registry; unknown/invalid version becomes a read error that
  triggers fallback.
- **agy:** leave `REQUIRED_PAYLOAD_KEYS` alone so v1 reads keep passing; validate v2 keys
  conditionally **on append only** (`if (ArgEvent.v >= 2)`); let the fold apply v1 defaults. A
  read-error path *"just creates brittle infrastructure"*.

**Adjudication: agy's design, with Codex's guarantee preserved elsewhere.** agy is right that
`readAll()` does not validate payloads today (`src/event-store.js:248-250` checks only that the type
is known), so making reads throw is new brittleness on the path we least want to destabilise.
Conditional append-time validation gets the write guarantee. Codex's concern — that a `v:2` label
would otherwise mean nothing — is answered by having **the parity check record the version**, so a
v1-only stream can never claim v2 parity. Guarantee kept; read path untouched.

### Disagreement 3 — relay-state fan-out

- **Codex:** one event per affected reminder, or relay-keyed with deterministic fan-out.
- **agy:** a single `ThreadRelayStateChanged` carrying `OriginalThreadTs`, with the fold applying it
  to every reminder sharing that thread identity.

**Adjudication: agy.** Relay state is genuinely thread-scoped, not reminder-scoped, so fanning out at
emission time invents a cardinality the domain does not have — and it would break the moment a new
reminder joins an existing thread. Thread identity is already the established key here: GH-27 defines
it as `OriginalThreadTs ?? OriginalMessageID`.

### Where both agreed

Merging the original A and B. A widened payload without lifecycle coverage produces a fold that
succeeds while silently retaining stale state. Both models called this independently.

## Phases

### Phase A — Schema v2: widen payloads AND complete emission coverage, together

**Merged from the original A and B on Codex's recommendation.** Shipping widened payloads without the
missing transitions produces a schema that *looks* sufficient while a fold still silently retains
`scheduled` for a reminder that actually went `overdue`. Half a schema is worse than a uniform gap,
because it invites a premature parity claim.

- [x] **Closed `(version, type)` registry, enforced on APPEND.** `REQUIRED_PAYLOAD_KEYS_V2` sits
      beside the v1 map; `NormalizeEvent` selects the set from the event's own `v` and treats a
      missing version as v1. Every producer now writes `v:2`.
- [ ] ~~**Make an unknown or invalid version a projection-read error.**~~ **Not implemented, by
      decision.** This was Codex's half of a genuine disagreement; agy's argument won on mechanism:
      `readAll()` does not validate payloads today (it checks only that the type is known), so making
      reads throw adds new brittleness to the path we least want to destabilise. Codex's guarantee is
      preserved by a different route — the strict gate records what the fold could not reproduce, so
      a v1-only stream cannot claim parity and therefore cannot serve a projection.
- [~] **Replace key-presence with real decoding.** *Partially done.* The `undefined` hole is closed:
      validation now requires the value to be defined, not merely present, because `JSON.stringify`
      drops an `undefined` and the event would have been written with the field missing. Full type /
      finite-number / timestamp decoding is **not** implemented — the fold coerces defensively at read
      time (`GetStringOrNull`, `Number.isFinite`) rather than the store rejecting at write time.
      Carried into Phase D as a hardening item, not claimed here.
- [x] Extend `ReminderCreated` v2 with `createdOn`, `originalSenderId`, `originalMessageId`,
      `originalThreadTs`, `originalChannelName`, `ignoreSnooze`, **`assigneeIds`** and **`clientId`**.
      The last two were agy's blocker: `AssigneeIDs` is the authoritative array and `AssigneeID` only
      its deprecated first-entry mirror (`src/reminders-module.js:84-85`), so requiring the scalar
      alone would let the ledger quietly undo GH-22's multi-assignee support, shipped this morning.
- [x] Extend `ReminderCompleted` v2 with `sourceChannelId`, `dueDate`, `clientId`, and `completedMs`.
      **Sample `Date.now()` once inside `#TransitionReminderState`** and pass the same value to both
      `#RecordCompletion` and the event; derive `completedAt` from it. Codex confirmed this does not
      breach the FSM contract — `validate-fsm-invariants.js` governs direct state assignment and
      construction bypasses, not timestamp provenance.
- [x] **Emit every persisted transition**, or a general state-transition event. Production persists at
      least `overdue` when no posting occurs (`src/reminders-module.js:3229`), so omitting it is not
      theoretical.
- [x] **Relay state as its own event, with fan-out modelled explicitly.** One Slack thread can affect
      several reminders, so this is either one event per affected reminder or a relay-keyed event
      whose fold fans out deterministically. Putting initial booleans on `ReminderCreated` is *not*
      sufficient, because the state changes later. Emit from `github-comment-relay.js` instead of
      mutating JSON silently.
- [x] Carry the `IgnoreSnooze` reset in the reschedule path.

**Exit criteria:** every new event is v2 and decodes; every historical v1 event still reads under its
original schema; a test asserts a v1 event without v2 keys is accepted, a v2 event without them is
rejected, and a payload key present-but-`undefined` is rejected.

### Phase B — Backfill by appending, never by rewriting

- [x] Append an explicit **v2 "current state imported" snapshot** for every record whose existing v1
      history cannot prove parity. This preserves append-only auditability; rewriting JSONL history
      does not.
- [x] **Teach the baseline importer an enrich mode.** As written it skips any ID that already has a
      creation or import event, so it is structurally unable to upgrade exactly the records that need
      it (`scripts/baseline-import.js:192`).

**Exit criteria:** a workspace with only v1 history reaches full parity after the backfill, proven by
diff rather than asserted.

### Phase C — Generation-aware parity gate (separate release)

**Status: the field-level half is implemented; the generation checkpoint is not.** What shipped is a
strict gate that rejects a stream missing what v2 added — enough to make a *pre-v2* stream fall back,
not enough to detect a *post-v2* stream that went short between a mutation and a read.

**Codex was explicit that a periodic checkpoint with a staleness bound is NOT sufficient**, and it is
right: appends are fire-and-forget, so a ledger can go short *immediately* after a checkpoint passes.

- [ ] Cache a full semantic parity result keyed by a **per-workspace authoritative mutation
      generation**: mark dirty before every JSON mutation; clear only once the relevant ledger
      append(s) *and* the JSON save are known complete; serve the projection **only while clean**,
      otherwise recompute or fall back. **Not started.** This is the checkpoint that
      `REMINDERS_READ_SOURCE` is blocked on, and no schema field substitutes for it.
- [x] Compare active reminders **and** completions, every field each surface consumes — not ID sets.
      The field-level gate now covers creation fields, relay state, `completedMs` and `ignoreSnooze`;
      `scripts/projection-parity-harness.js` does the byte/semantic comparison.
- [ ] Give `readAll()` an error signal so a truncated or unreadable log is distinguishable from an
      empty one. **Not started** — see the read-strictness decision recorded under Phase A.

**Exit criteria:** a torn append makes the next read fall back with a logged warning; a dropped paired
event is detected; a mutation between checkpoint and read cannot serve stale projection data.

### Phase D — Prove on real data, then unblock one flag at a time

- [ ] Run the full-state diff — the spike that should have opened this plan — against real
      `neochrome` data: fold every reminder, diff every field against the JSON store.
- [ ] Unblock flags **individually**, each with its own recorded passing parity run.
- [ ] Only then do Phase 4, Phase 6a, and the reversibility drill return.

**Exit criteria:** zero field diffs on real data, or a documented and accepted divergence per field
(the ±1ms `completedMs` precedent).

## Sequencing

**A + B are one release. C is a separate release.** D gates everything downstream.

I originally wrote that "Phase A alone stops the log accruing more unreconstructible history" and
proposed landing it first. **Codex rejected that and I accept the correction:** widened payloads
without complete emission coverage still produce unreconstructible history, just less obviously — and
a half-widened schema is more dangerous than a uniform gap because it invites a premature parity
claim.

## Progress log

- **2026-08-08** — Proposal written after three marathon phases and three QA rounds converged on one
  root cause. Gaps 1-6 verified in source; gap 7 identified by Codex QA round 2.
- **2026-08-08** — Phases A, B and C implemented on `marathon/p3-phase5-read-cutover-2026-08-08`.

  **Phase A** (`8080fab`) — `REQUIRED_PAYLOAD_KEYS_V2` beside the v1 map, selected by the event's own
  `v` so historical events read unchanged. Closed a validation hole Codex found: `hasOwnProperty`
  returns true for `undefined`, which `JSON.stringify` then drops, so an event could validate and be
  written with the field missing. `assigneeIds` required, per agy's blocker. `completedMs` sampled
  once in `#TransitionReminderState` and threaded to both the `CompletionRecord` and the event.
  Generic `ReminderStateChanged` for the seven states the switch skipped.

  **Phase A/relay** (`e1b9bf5`) — `ThreadRelayStateChanged`, thread-scoped per agy's adjudicated
  design, carrying the synthetic `thread:<key>` envelope id. The fold applies it after the main loop
  so a reminder created later still inherits its thread's state. Fixed en route: relay-started was
  gated on `IsFirstRelay`, so a reminder joining an already-relaying thread was recorded as
  never-relayed forever — which also made the JSON store and the thread event disagree.

  **Phases B + C** (`f9a40c7`) — `--enrich` backfill, and a fold that treats a repeat creation event
  as enrichment rather than a second reminder. `FindMissingTransitionFields` rejects a
  `ReminderCompleted` without `completedMs` and a `ReminderScheduled` without `ignoreSnooze`.

  **That gate immediately caught a live defect**: `state-snapshot-writer.js` compaction was dropping
  `completedMs` and both relay flags. Compaction *replaces* the log, so those fields would have been
  destroyed permanently — a compaction would have resumed a relay a user had stopped, with no earlier
  event left to contradict it. The open relay-capable path had no test coverage; it does now.

  **Not done, and named rather than implied:** no flag was unblocked (Phase D needs a real-data
  parity run, an operator step); the generation-aware checkpoint in Phase C is not started, so a
  post-v2 stream that goes short between a mutation and a read is still undetectable, which is why
  `REMINDERS_READ_SOURCE` stays blocked; `readAll()` still has no error signal; and full type/timestamp
  decoding at write time was not implemented — the fold coerces defensively at read time instead.
  Read-strictness was a genuine Codex/agy disagreement resolved in agy's favour, recorded under
  Phase A rather than quietly dropped.
