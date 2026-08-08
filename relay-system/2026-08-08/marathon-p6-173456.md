# Marathon Phase p6
STATUS: Approved
NEXT: codex

<!-- marathon-drive: task=MARATHON-P6-TURN-2 builder=codex reviewer=agy round-cap=7 -->

## Phase Brief

# p6 — Phase 5: migrate remaining projections, with a parity harness

Release 1.5.0 "Ledger" · P3 Phase 5 · depends on **p4** (re-pointed 2026-08-08; was p5)

> **Why not p5.** p5 (Phase 4, boot-time rebuild) HALTED — the event schema cannot reconstruct boot
> state — and is deferred behind its own schema-expansion proposal. Depending on it made this lane
> permanently unopenable. Depending on p4 is correct, not a workaround: this phase converts reads to
> projections *behind flags with fallback to the authoritative store*, the same strangler pattern
> Phase 2 shipped for `summarize-week` with no boot-rebuild. Nothing here needs the log authoritative
> at boot.

Authority-moving phase. The reversibility contract in `MARATHON.yaml` is binding.

## Goal

Convert the remaining reads to folds over the log: `_reminders.json`, `_completed.json`, and the
`?format=rebalance` export consumed by `deploy/reminders-export/publish-reminders-export.mjs`.

## Parity harness FIRST — this is not optional

The spec requires a parity harness **before** cutover: compare old JSON/API output against the
folded output, byte-compatible where feasible, semantically diffed where timestamps or ordering
legitimately differ.

Build `scripts/projection-parity-harness.js` before flipping anything. This is the same discipline
that made Phase 2 safe: its shadow-diff found a real pre-ledger gap (11 mismatches) that no amount
of code review had surfaced, and GH-355 closed it to 0. Skipping the harness here removes the only
mechanism that has actually caught this class of bug in this codebase.

The rebalance export has an **external consumer** (HiQS). Its output must be byte-compatible —
shadow-diff the rebalance JSON before cutover, not after.

## Switches

One flag per read surface, not one global flag. Each defaults OFF, each independently reversible:

- `REMINDERS_READ_SOURCE=projection`
- `COMPLETED_READ_SOURCE=projection`
- `REBALANCE_EXPORT_SOURCE=projection`

Per-surface flags mean a parity failure on the export does not force rolling back reminders reads.
A single global flag would couple three independent risks into one switch.

Every path keeps the `try/catch` → authoritative-store fallback.

## What must NOT change

JSON writes continue. Phase 6 (removing them) is excluded from this release — see `MARATHON.yaml`.

## Entity-linking fold-in

Where it *materially* improves output, reuse the Phase 3 canonical client/project identity rather
than repeating one-off inference per read surface. If it does not clearly improve a surface, leave
that surface alone — this phase's job is parity, not enrichment.

## Done when

- [ ] parity harness exists and runs against a real fixture, reporting byte-diffs and semantic diffs
      separately
- [ ] rebalance export proven **byte-compatible** with today's output
- [ ] each of the three flags: unset → today's output byte-for-byte; on → parity-clean
- [ ] **tested rollback** per flag: flip on, flip off, assert output returns to the JSON-sourced
      result — three separate tests, since the flags are independent
- [ ] an induced projection error falls back to the authoritative store and logs
- [ ] `npm test`, `npm run build`, `npm run validate:fsm` green

## Escalate rather than force

If any surface cannot reach parity, HALT and report the diff. Shipping a read surface that is
"close enough" silently changes what users and the HiQS export see.

### Round 1 · Builder · codex

HALT — the current ledger schema cannot prove the required lossless read cutover, so I made no
artifact changes beyond this breadcrumb.

- Reproduced the focused parity check with `node --test tests/projection-parity.test.js` (11/11
  pass). That result is not a valid cutover proof: its green byte-parity fixture writes both
  sides with `SerializeCanonical`, so it compares a normalized representation rather than the
  native `_reminders.json` bytes that the requirement names.
- Traced the fail path: `ReminderInfo` persists `GitHubRelayStarted` and `GitHubRelayStopped`
  (`src/reminders-module.js` typedef), but both the native `ReminderCreated` payload and
  `scripts/baseline-import.js`'s `BaselineReminderImported` payload omit them. The GitHub relay
  mutates those fields without a lifecycle event, so `FoldReminderReadModels` has no evidence
  with which to reconstruct their current values. A projection-selected boot can therefore reset
  relay suppression/history despite strict mode reporting success.
- Hypothesis checked: this is an event-schema gap, not a test-fixture typo. The existing strict
  check only guards six creation fields and does not validate later relay state. Adding a local
  default would conceal the mismatch; adding a relay event/schema is outside this lane's allowed
  files and must precede Phase 5.

Next work: expand the ledger contract to capture relay-state mutations (and any other persisted
fields required by the boot reader), backfill/import those fields, then run the harness against
raw captured JSON/API responses without canonicalizing the byte-comparison inputs. No flag should
be enabled until that report is clean.


## Debug mantra (auto-triggered — 1 prior attempt(s) on this phase did not reach Approved)

Before trying again, read <home>/wt/ledger-p3-phase5-read-cutover/.xyz/relay-automation/DEBUG-MANTRA.md and follow its four-step discipline: reproduce reliably, know the fail path, question the hypothesis, treat this round as a breadcrumb for the next one.
Last recorded reason (<home>/wt/ledger-p3-phase5-read-cutover/phases/ledger-p3-phase5-read-cutover--p6/ESCALATION.md): `containment-violation (off-lane edit reverted by a turn-taker)`. Read it before re-guessing.

---

▶ TAKE YOUR TURN (codex — BUILDER role)

You are the BUILDER for this phase. Read the phase brief above and implement it.
1. Implement the brief by creating/editing the artifact file(s): src/reminders-projection.js,scripts/projection-parity-harness.js,tests/projection-parity.test.js,src/reminders-module.js,src/web-api.js,package.json,package-lock.json,tests/reminders-integration.test.js,tests/web-api-reminders.test.js,tests/completion-store.test.js
2. Append a build block to this relay file: `### Round N · Builder · codex` summarizing what you did (files touched, key decisions).
3. Use this exact tick binary (run it from any directory): <home>/wt/ledger-p3-phase5-read-cutover/.xyz/bin/tick
   - <home>/wt/ledger-p3-phase5-read-cutover/.xyz/bin/tick claim MARATHON-P6-TURN-2 --agent codex --paths "phases/ledger-p3-phase5-read-cutover--p6/RELAY.md,src/reminders-projection.js,scripts/projection-parity-harness.js,tests/projection-parity.test.js,src/reminders-module.js,src/web-api.js,package.json,package-lock.json,tests/reminders-integration.test.js,tests/web-api-reminders.test.js,tests/completion-store.test.js"
   - <home>/wt/ledger-p3-phase5-read-cutover/.xyz/bin/tick ping MARATHON-P6-TURN-2 --agent codex
   - <home>/wt/ledger-p3-phase5-read-cutover/.xyz/bin/tick release MARATHON-P6-TURN-2 --agent codex --to agy
4. Edit ONLY these paths: phases/ledger-p3-phase5-read-cutover--p6/RELAY.md and src/reminders-projection.js,scripts/projection-parity-harness.js,tests/projection-parity.test.js,src/reminders-module.js,src/web-api.js,package.json,package-lock.json,tests/reminders-integration.test.js,tests/web-api-reminders.test.js,tests/completion-store.test.js. Do NOT run git. Do NOT touch any other file — the harness commits for you.
5. HAND OFF EXPLICITLY (GH-268): after releasing the token, end your turn by naming who acts next —
   "handing off to agy — agy, take your turn." A turn that ends without that line
   leaves a human guessing whether the relay is waiting on them or has stalled. Do this EVERY round,
   not just the first.

---

▶ TAKE YOUR TURN (agy — REVIEWER role)

You are the REVIEWER for this phase. Read the latest builder block above AND review the artifact file(s) on disk: src/reminders-projection.js,scripts/projection-parity-harness.js,tests/projection-parity.test.js,src/reminders-module.js,src/web-api.js,package.json,package-lock.json,tests/reminders-integration.test.js,tests/web-api-reminders.test.js,tests/completion-store.test.js. REVIEW THE WHOLE FILE, NOT JUST THE DIFF (GH-268): a beta test had this loop reach 'Approved' in two rounds while an independent audit of the same branch found 20 issues (1 critical, 4 high) — every one of them in the pre-existing code the change sat on, which nobody had read. Pre-existing defects in a file you are touching are IN SCOPE; say so explicitly if you find none. DECLARE IT: your review block MUST contain a literal 'swept file: yes' or 'swept file: no' line — without it a reviewer that skipped the sweep is indistinguishable in the transcript from one that did it and found nothing, which is exactly how those 20 issues stayed invisible.
1. Append a review block: `### Round N · Reviewer · agy` followed by your assessment.
2. If changes needed: add `**Verdict:** Changes requested` then: <home>/wt/ledger-p3-phase5-read-cutover/.xyz/bin/tick release MARATHON-P6-TURN-2 --agent agy --to codex
3. If satisfied: add `**Verdict:** Approved`, set `STATUS: Approved`, then: <home>/wt/ledger-p3-phase5-read-cutover/.xyz/bin/tick done MARATHON-P6-TURN-2 --agent agy
4. Use this exact tick binary (run it from any directory) for all token operations: <home>/wt/ledger-p3-phase5-read-cutover/.xyz/bin/tick
   Edit ONLY phases/ledger-p3-phase5-read-cutover--p6/RELAY.md (your review block + STATUS). Do NOT edit the artifact yourself — request changes instead. Do NOT run git.
5. HAND OFF EXPLICITLY (GH-268): end your turn by naming who acts next — "handing off to codex —
   codex, take your turn" when requesting changes, or "relay closed, no further turn needed" when
   approving. The beta report singled this out: the Reviewer turn did not tell the user to go back to the
   Producer, so the relay looked stalled when it was simply waiting. Do this EVERY round.

### Round 1 · Reviewer · agy

swept file: yes
The builder correctly identified that the event schema is missing relay state fields (`GitHubRelayStarted`, `GitHubRelayStopped`), which prevents a lossless read cutover. As instructed by the brief ("If any surface cannot reach parity, HALT and report the diff"), the builder escalated this issue rather than forcing a lossy cutover, and made no artifact changes. This is the correct outcome. The missing schema updates must be addressed in a prior phase.

**Verdict:** Approved

