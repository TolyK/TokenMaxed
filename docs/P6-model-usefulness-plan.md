# P6 — Tracking Real Per-Model Usefulness in the Wild

**Status:** design only (no code). Author: routing/feedback subsystem. **Plan version: v3.**
**Scope of this document:** a development plan an engineer can execute and an operator can approve or reject. Every claim below is grounded in the current source; file:line citations are inline and were re-verified for v2 (see the revision log).

---

## Revision log (v3 — addresses Codex review of v2)

Fixes the three blockers + two should-fixes Codex raised against v2 (each verified against source):
1. **Subject-model wording (was overstated).** `subject_model` is NOT yet recorded; it is **derivable** from `request.subjectLane.model` (`Lane.model: string`, `types.ts:88-97`). Phase-1 ADDS the recording. Corrected in §0.5/log-item-2.
2. **Escalation uses EFFECTIVE capability, not declared (factual fix).** `selectEscalationTarget`/`reassignmentTarget` read `effectiveCapabilityFor` (`reassign.ts:92, 193`) — i.e. post-overlay, which is INTENTIONAL (never escalate to an empirically-failing lane), so escalation DOES consume the P6 model posterior. Only reviewer/manager **eligibility** stays on declared (`isManagerEligible` `route.ts:139-143`; `selectReviewManager` `review.ts:221,234,242`). Invariant (b) is about *eligibility*, not escalation. Corrected in §3c.
3. **P2 bridge precondition.** The model-key merge requires the lane `model` be CONCRETE. The adapter pre-resolves `@latest` via `resolveLaneModel(lane, priceTable)` (`server.ts:310,337`) before scoring; without a price table `resolveLaneModelId` (`capability-prior.ts:345`) returns the alias unchanged and would key separately. Phase-1 relies on adapter pre-resolution; stated as an explicit precondition in §3d.
4. **Leaderboard dedup + anonymization (was under-specified — the real blocker).** Integer addition is NOT idempotent on re-upload. Phase-2b now uses **replace-by-snapshot per `(contributor_id, window_id)`** (a re-upload REPLACES that contributor's prior snapshot for the window, never adds), so re-uploads are idempotent and only *distinct contributors* sum. `users` = count of distinct `contributor_id`s per `(model,category,difficulty)` cell. **k-anonymity: a cell is suppressed from the published chart until `users >= MIN_USERS` (and a min sample count)** — token sums/rates are never published for a thin cell. `contributor_id` is a rotatable pseudonym used server-side for dedup ONLY and is never published. "Aggregation is the anonymization" is RETRACTED — aggregation + min-N suppression + pseudonymous dedup is the boundary. Corrected in §6/§6.5.
5. **Worker preconditions.** Grok (W1) must be installed + available; Antigravity (W2) ships **blocked** by default (`lanes.starter.yaml:125`) and must be enabled with its companion path configured before use. Claude/Codex assignments are process guidance, not source-verified facts. Noted in §10.

## Revision log (v2)

This revision (a) **adds the Phase-2 public real-usage leaderboard** as the operator's required deliverable (new §6.5, with its data source tied back to the Phase-1 schema), and (b) **hardens** the load-bearing claims so the plan pre-empts a Codex review. Source-verified deltas vs v1:

1. **Citation-path corrections (verified).** v1 cited the adapter as `server.ts` and `host-review.ts` with no package path. The real files are `packages/mcp/src/server.ts` and `packages/mcp/src/host-review.ts`. Every such citation below is now fully qualified.
   - `@latest`→concrete resolution happens at **`packages/mcp/src/server.ts:310`** (preview/candidate path) and **`packages/mcp/src/server.ts:337`** (delegate path), via `resolveLaneModel(lane, priceTable)` — v1's "308-309" was imprecise.
   - The host-turn review call is **`packages/mcp/src/host-review.ts:118-119`** and passes **no `subjectLane`** (verified: the request object is `{ turn_id, category, content }` only) — so `subject_model` is correctly absent there.
2. **Subject-model availability (load-bearing, §0.5/§2.2) — CONFIRMED.** `review()` reads `request.subjectLane.id`/`.provenance` at **`review.ts:107-109`**; the same `Lane` object carries `.model` (the `Lane` type has `model: string`). The router-task path passes `subjectLane` at **`run.ts:609`** (the `review(...)` call spans `run.ts:608-611`). No new plumbing is needed to *know* the model — only a field to *record* it. **It is NOT recorded today**: `subject_model` is *derivable* from `request.subjectLane.model` (`Lane.model: string`, `types.ts:88-97`), and Phase-1 ADDS the recording inside the existing `if (request.subjectLane)` block at `review.ts:107-110`, alongside the current `subject_lane_id` assignment.
3. **Model-keying invariants (§3c) — re-verified line-exact.** capability-0 opt-out: `effectiveCapability` returns 0 when `prior === 0` at **`route.ts:243`**, and `compareScores` hard-sinks any lane whose `factors.capability === 0` at **`route.ts:307-309`**. Reviewer/manager eligibility reads no observed term: `isManagerEligible` (**`route.ts:139-143`**) uses only trust/origin/attestation; `selectReviewManager` uses `declaredCapabilityFor` (**`review.ts:221, 234, 242`**). Zero-change-when-absent: `effectiveCapabilityFor` falls through to declared at **`route.ts:273-274`**; `buildObserved` returns `undefined` when learning is off at **`packages/mcp/src/server.ts:242-243`**.
4. **P2 reconciliation (§3d) — bridge made explicit.** `CapabilityPriorOverlay` is **lane-keyed** (`types.ts:193`) but **model-derived** (`overlayFromSnapshot` resolves lane→model→snapshot at `capability-prior.ts:382-405`, via `resolveLaneModelId` at `capability-prior.ts:345-349`). P6's posterior is model-keyed. The bridge: both sides resolve `lane → modelKey` with the *same* primitive (`resolveLaneModel`/`parseModelAlias`), so prior and posterior share the model axis even though P2's overlay storage stays lane-keyed in Phase 1. `priorStrength` (k) by rankings confidence is unchanged (`capability-prior.ts:35-44`, `PRIOR_STRENGTH_BY_CONFIDENCE`).
5. **Difficulty signal (§4) — confound acknowledged.** Escalation-depth stays the Phase-1 default, but it is **itself confounded** (a strict reviewer inflates "hard"; a lenient one deflates it). Now stated explicitly. Reviewer-assigned difficulty (option c) remains a deferred operator decision.
6. **Migration (§2.4/§7).** schema_version 1→2; new fields OPTIONAL; deterministic; old ledgers read unchanged. F-1's handling of events lacking `subject_model` = **treat-as-unknown** (excluded from model-keyed learning), with an optional read-time join-by-`(task_id, attempt)` backfill, never a ledger rewrite.
7. **Selection bias (§5) — kept + mitigation noted.** Winners accrue more samples; acknowledged (matching F-1's own banner at `feedback.ts:13-18`), optional epsilon-explore deferred to the operator.
8. **Phase-2 consent/upload (§6/§6.5).** Opt-in, off by default; content-free aggregate boundary (counts only); the single-user bootstrap needs **no upload at all** (local chart) — upload is purely for cross-user densification.
9. **Phasing/workers (§8/§10).** Each phase independently shippable + testable; gates include `build:plugin` bundle regen. Implementation goes to cheap workers (**Grok W1 → Antigravity W2**), Claude only as last-resort fallback if both fail review; Codex reviews the hardest surfaces (content-free allowlists, model-keying invariants, the leaderboard aggregate boundary).

---

## 0. The problem, verified against the code

TokenMaxed's defensible asset is a proprietary, continuously-updated record of how each **specific model** does on real coding tasks, conditioned on difficulty — "feedback on each model in the wild." Today the system records the cost side of that per model but throws away the **quality** side's model identity and has **no difficulty axis at all**. Verified:

1. **Task events carry model identity (good).** `TaskEvent`/`TaskEventInput` has `model: string` (`packages/core/src/ledger.ts:75`), it is in the allowlist `EVENT_FIELDS` (`ledger.ts:140`), validated (`ledger.ts:229`), and already aggregated per model in `tokenStats.byModel` (`ledger.ts:493, 498`). The cost/usage side has model identity.

2. **The quality signal does NOT carry the subject's model.** `OutcomeEventInput` (the review verdict) records `subject_lane_id` and `subject_provenance` (`ledger.ts:112-113`) but there is **no `subject_model`**. The allowlist `OUTCOME_EVENT_FIELDS` (`ledger.ts:146-152`) confirms it: `subject_lane_id`, `subject_provenance`, `reviewer_model` — but no field for the model whose work was judged. You can only recover it by joining the outcome to its task event on `(task_id, attempt)`.

3. **F-1 learning is keyed by LANE, never by model.** `outcomeCapability` (`packages/core/src/feedback.ts:95`) accumulates decay-weighted verdicts into an accumulator keyed `[laneId, category]` (`feedback.ts:124`) and emits `ObservedCapabilityByLane = { [laneId]: { [category]: { rate, n } } }` (`feedback.ts:135-141`, type at `packages/core/src/types.ts:257`). The de-dup key is `[task_id, attempt, subject_lane_id, category]` (`feedback.ts:75`). A lane such as `claude-cli` blends every verdict regardless of which concrete model actually ran. When the model behind a lane changes — `@latest` resolution (`packages/core/src/model-freshness.ts:98 resolveLaneModel`), a repin, or an upgrade — old-model verdicts keep feeding the new model's prior until the 30-day half-life decays them (`feedback.ts:38 DEFAULT_HALF_LIFE_DAYS = 30`). **Lane ≠ model. We learn on the lane.**

4. **There is no difficulty/complexity signal anywhere.** The only task descriptor is `category`, a fixed 7-bucket enum (`types.ts:63-81`). We cannot distinguish "model X passes easy bugfixes but fails hard ones" — and the hard tail is exactly where misrouting (the core product risk) lives. P3's classifier yields a *classification* confidence (the margin between the top and second category score, `packages/core/src/classify.ts:174-178`), not difficulty, and it is not recorded on any event.

5. **The subject model IS available at the moment the verdict is produced (load-bearing claim — re-verified for v3).** `review()` receives the full subject `Lane` as `request.subjectLane` and already reads `.id`/`.provenance` from it (`packages/core/src/review.ts:107-109`); the same `Lane` object carries `.model` (the `Lane` type declares `model: string`, `types.ts:88-97`). The router-task review call passes `subjectLane` directly — the `review(...)` invocation spans `packages/core/src/run.ts:608-611`, with `subjectLane` passed on `run.ts:609`. For host-turn reviews there is no subject lane: the call at `packages/mcp/src/host-review.ts:118-119` is `{ turn_id, category, content }` only — no `subjectLane` — so `subject_model` is simply absent there, the same shape as today's absent `subject_lane_id`. **No new plumbing is needed to know the model; only a field to record it.** Today `review()` records `subject_lane_id`/`subject_provenance` but NOT the model; Phase-1 ADDS the `subject_model` recording (derived from `request.subjectLane.model`) in that same `if (request.subjectLane)` block at `review.ts:107-110`.

**Net:** we are discarding the single most valuable column on our most valuable table, and we have no difficulty axis. P6 fixes both, locally first (Phase 1), then turns the per-model × difficulty acceptance record into the cross-user moat (Phase 2).

---

## 1. Goal & non-goals

**Goal.** Make TokenMaxed learn (and, later, share in aggregate) *which specific model keeps passing reviews, at what difficulty, per category* — so routing follows the model, not the lane label, and the hard tail becomes legible.

### Phase split (decided up front)

- **PHASE 1 — local per-model learning (in scope for a first approvable build).**
  1. Add `subject_model` (+ canonical/version handling) to `OutcomeEvent` and its allowlist.
  2. Re-key F-1 from lane×category to **model×category(×difficulty)**, with a lane→model resolution at scoring time, preserving every existing routing invariant.
  3. Add a bounded, content-free **difficulty bucket** to the events and condition capability on it.
  All three are pure-core changes (`ledger.ts`, `feedback.ts`, `route.ts`, `types.ts`) with thin adapter wiring; all unit-testable; all degrade to today's behavior when absent.

- **PHASE 2 — cross-user anonymized aggregation (the moat; NOT in the first build).**
  Opt-in upload of aggregate counts `(model, category, difficulty) → {pass, needs_rework, fail}`. No per-task rows, no text, ever. Consent, anonymization, and the content-free boundary are designed here but built only after Phase 1 has shipped and produced real local data.

### Non-goals

- Not changing what routing *optimizes* (still cheapest-capable; `route.ts:383 routeDecide`). P6 changes the *capability input*, not the objective.
- Not ground-truth model benchmarking. The signal stays a review verdict (see §5).
- Not adding any task **content** to the ledger — the content-free invariant (`ledger.ts:6-12`, README "Privacy invariant (absolute)" at `README.md:61-63`) is law.
- Not touching reviewer/manager **eligibility**, which stays on *declared* lane capability (§3c).
- Phase 2 upload is explicitly out of the first build.

---

## 2. Model identity on the quality signal

### 2.1 Schema change

Add to `OutcomeEventInput` (`ledger.ts:104`):

- `subject_model?: string` — the concrete model the subject lane ran (e.g. `claude-opus-4-8`). Optional: host-turn reviews and legacy events won't have it.
- `subject_model_resolved?: string` — the canonical key after `@latest`/alias resolution (see 2.3). When the lane was already pinned concrete, this equals `subject_model`.

Add both to `OUTCOME_EVENT_FIELDS` (`ledger.ts:146`) so they serialize (the allowlist is the content-free guarantee — anything not listed is dropped by `serializeFields`, `ledger.ts:285-292`). Both are plain model-id strings — ids, not content — so they satisfy the content-free rule exactly as `reviewer_model` already does (`ledger.ts:150`).

Validate in `validateOutcomeInput` (`ledger.ts:253`) with the existing `optionalString` helper (`ledger.ts:173`), mirroring how `subject_lane_id`/`subject_provenance` are handled at `ledger.ts:272-275`.

### 2.2 Population at review time

`review()` already has the subject lane object. In `review.ts:107-110`, where it sets `subject_lane_id`/`subject_provenance` from `request.subjectLane`, also set:

- `event.subject_model = request.subjectLane.model`
- `event.subject_model_resolved = <canonical>` (see 2.3)

The router-task path (the `review(...)` call at `run.ts:608-611`, passing `subjectLane` on `run.ts:609`) already passes `subjectLane`, so no call-site change is needed there beyond what `review()` reads. Host-turn reviews (`packages/mcp/src/host-review.ts:118-119`) pass no subject lane → both fields stay absent, which is correct (there is no single subject model for a host diff).

**Important ordering note:** lanes are resolved to concrete models *before* execution. The routing path resolves `<family>@latest` to a concrete priced id via `resolveLaneModel` (`packages/mcp/src/server.ts:310, 337`; `packages/mcp/src/host-review.ts:309`). So by the time work runs and is reviewed, `subjectLane.model` is typically already concrete. `subject_model` records what actually ran; `subject_model_resolved` is the canonicalized key for learning.

### 2.3 Canonicalization

Reuse the model-freshness primitives so one model is one stable key and version drift is handled deterministically:

- `parseModelAlias(model)` (`model-freshness.ts:25`) — if the lane is still an unresolved `<family>@latest` alias, canonicalize via `resolveLaneModel(lane, priceTable)` (`model-freshness.ts:98`) to the newest priced family member, exactly as the prior overlay does in `resolveLaneModelId` (`capability-prior.ts:345-349`).
- The canonical key is the resolved concrete id (e.g. `claude-opus-4-8`), lower-cased only if we adopt the same case-folding the freshness checks use (`sameFamily` folds case, `model-freshness.ts:199-209`). **Decision:** store the resolved id *verbatim* (matching the price-table key casing — see the memory note "Price-table vendor-exact ids") and case-fold only at *comparison* time inside feedback, so we never mutate a vendor-exact id on disk.

This makes the learned posterior key align with P2's prior key: P2 also resolves lane→model→snapshot via the alias table (`capability-prior.ts:351-361 findSnapshotEntry`, keyed by `snapshot.aliases[resolvedModel]`). Prior and posterior end up on the **same model axis** (see §3d).

### 2.4 schema_version bump + migration

`SCHEMA_VERSION` is `1` (`ledger.ts:20`); bump to `2`. The reader already tolerates older events: `parseMeta` defaults a missing `schema_version` to `0` (`ledger.ts:307-308`) and `parseEvent` backfills legacy task rows (`ledger.ts:323-345`). Historical `OutcomeEvent`s simply lack `subject_model` — which is allowed because the new fields are optional. **Migration policy for the missing model on old outcomes:**

- **Default: treat-as-unknown.** An outcome with no `subject_model` is excluded from model-keyed learning (it still counts in the legacy lane-keyed view if we keep one, and in `outcomeStats`). This is the honest, zero-risk default: we never *guess* which model produced old work.
- **Optional backfill-by-join (operator tool, not automatic).** A one-shot, read-only utility may join old outcomes to their `TaskEvent` on `(task_id, attempt)` (the same correlation keys F-1's de-dup uses, `feedback.ts:75`) and recover `TaskEvent.model` (`ledger.ts:75`). Recommended as a *derived in-memory* enrichment at read time rather than rewriting the append-only ledger (append-only is invariant #2, `ledger.ts:8-9`). Rewriting history is discouraged; if ever done it must be an explicit, logged migration that preserves byte-for-byte every other field.

**Decision:** ship treat-as-unknown; offer join-enrichment at read time behind a flag if real ledgers show enough pre-P6 volume to matter.

---

## 3. Re-key F-1 by MODEL × category (× difficulty)

### 3a. The model-keyed observed overlay

Add a parallel type to `types.ts` (near `ObservedCapabilityByLane`, `types.ts:257`):

```
ObservedCapabilityByModel = Record<modelKey, Partial<Record<TaskCategory, ObservedCapability>>>
```

and, once difficulty lands (§4), a difficulty-conditioned variant:

```
ObservedCapabilityByModelDifficulty =
  Record<modelKey, Partial<Record<TaskCategory, Partial<Record<DifficultyBucket, ObservedCapability>>>>>
```

`ObservedCapability` (`{ rate, n }`, `types.ts:244-249`) is reused unchanged.

`outcomeCapability` (`feedback.ts:95`) gets a model-keyed sibling (or a keying option). Concretely:

- `isLearnableOutcome` (`feedback.ts:61-71`) gains a requirement that `subject_model_resolved` (or `subject_model`) is a non-empty string — so an outcome with no recorded model is *not* learned in the model view (the treat-as-unknown default from §2.4).
- The accumulator key (`feedback.ts:124`) becomes `[modelKey, category]` (and later `[modelKey, category, difficulty]`).
- The de-dup key (`feedback.ts:74-76`) keeps `task_id, attempt` but swaps `subject_lane_id` for the model key so a re-review of the same attempt still can't double-count, and two different lanes that happen to run the *same model* on the *same task/attempt* (not a real case today, but defended) don't collide incorrectly — include both `subject_lane_id` and `modelKey` in the de-dup tuple to be safe.
- Recency decay (`feedback.ts:119-122`, half-life `feedback.ts:38`) is unchanged.

The output is sparse and deterministic, exactly like today (`feedback.ts:135-142`).

### 3b. How a lane resolves to its model's posterior at scoring time

Routing scores **lanes** (`route.ts:277 scoreLane`, `route.ts:411 routeDecide`). The overlay is now keyed by model. Bridge it where the overlay is looked up:

- Today `effectiveCapabilityFor` reads `overlay?.[lane.id]?.[category]` (`route.ts:269, 274`) and `scoreLane` reads `observedCapability?.[lane.id]?.[task.category]` (`route.ts:285`).
- Change the lookup to resolve the lane to its **canonical model key** first (the same resolution as §2.3 / `capability-prior.ts:345-349`), then read `overlayByModel?.[modelKey]?.[category]` (and the difficulty cell when present, §4).

**Where resolution happens:** the host adapter already resolves lanes to concrete models before building the route context (`packages/mcp/src/server.ts:310, 337`). So the cleanest design keeps core pure: the adapter passes lanes whose `model` is already concrete, and core resolves `lane.model → modelKey` with the *pure* `parseModelAlias` only (no price table needed in the hot path because the adapter pre-resolved `@latest`). This mirrors how `capability-prior.ts:345-349` falls back to `parseModelAlias` when no price table is supplied.

This is the **whole point**: when a lane's model changes, its learned posterior *follows the new model id*. Old-model verdicts live under the old model key and no longer feed the new model — no 30-day cross-contamination (the bug in §0.3).

### 3c. Preserving the three invariants (non-negotiable)

1. **`capability: 0` opt-out stays lane-level and BEFORE any overlay (invariant a).** `effectiveCapability` returns `0` immediately when the declared prior is `0` (`route.ts:243`, `if (prior === 0) return 0;`), and `compareScores` hard-sinks any lane whose `factors.capability === 0` below all positive-capability lanes (`route.ts:307-309`). Both operate on the *declared lane* prior, untouched by P6 — the opt-out is decided *before* and *independently of* the model overlay. The model overlay is only consulted to compute the *observed* term inside `effectiveCapability`, which is unreachable once `prior === 0` short-circuits. **No change; the opt-out can never be resurrected by a model posterior.**

2. **Reviewer/manager ELIGIBILITY stays on DECLARED lane capability (invariant b).** `isManagerEligible` (`route.ts:139-143`) reads **no capability at all** — only `trust_mode === 'full'`, `manager_allowed === true`, and trusted origin/attestation. `selectReviewManager` ranks reviewer candidates with `declaredCapabilityFor` (`review.ts:221, 234, 242`). P6 must NOT route reviewer/manager *eligibility* through the model posterior — the reviewer's bar is config-declared, not earned by past verdicts (otherwise the loop would feed on itself); leave those `declaredCapabilityFor` calls as-is (`route.ts:181-184` is the never-mutated config prior).

   **Escalation, by contrast, INTENTIONALLY uses EFFECTIVE capability — and that's correct.** `reassignmentTarget` and `selectEscalationTarget` rank targets with `effectiveCapabilityFor` (`reassign.ts:92, 193`), i.e. the post-overlay value — so they already consume the learned signal today, and under P6 they will consume the model-keyed posterior. This is desired: you should not escalate to a lane whose *model* is empirically failing. So invariant (b) covers reviewer/manager **eligibility** only; escalation-target *ranking* deliberately rides the effective (now model-keyed) capability. No code change to reassign.ts's choice of `effectiveCapabilityFor` — only its underlying posterior becomes model-keyed.

3. **Zero change when absent (invariant c).** If the adapter passes no model overlay (learning off, or empty ledger), `effectiveCapabilityFor`/`scoreLane` fall through to declared/prior exactly as today (`route.ts:273-274`, and `scoreLane`'s `observedCapability?.[lane.id]?.[task.category]` at `route.ts:285` yields `undefined`). The `learnEnabled` gate (`packages/mcp/src/server.ts:217`) and the lazy `buildObserved` (`packages/mcp/src/server.ts:242-252`, returns `undefined` when `!learnEnabled`) already provide this fail-open behavior; P6 keeps it byte-for-byte — `buildObserved` simply returns the model-keyed overlay instead of the lane-keyed one (or both during a transition window). With no overlay, scores are identical to pre-P6.

### 3d. Reconciling with P2's prior overlay — share the model axis

**Bridge flag (verified):** P2's prior overlay (`CapabilityPriorOverlay`, `types.ts:193`) is keyed by **lane id**, NOT by model — `Record<string /*laneId*/, Partial<Record<TaskCategory, CapabilityPriorEvidence>>>`. It is, however, *derived from the model*: `overlayFromSnapshot` resolves each lane to its concrete model with `resolveLaneModelId` (`capability-prior.ts:345-349`) before looking the model up in the snapshot (`capability-prior.ts:382-405`). So in Phase 1 the two overlays have **different storage keys** (P2: laneId; P6: modelKey) but the **same resolution rule** (`resolveLaneModel`/`parseModelAlias`). The bridge is: at the scoring lookup, resolve `lane → modelKey` once and use it for the P6 posterior read, while P2's prior continues to be read by `lane.id` (its overlay is pre-built per lane). They compose because both were resolved from the *same* concrete model. No change to P2's storage shape is required in Phase 1. Proposal:

- **Prior = rankings, per model** (P2's snapshot is already model-sourced; `CapabilitySnapshotEntry.model`, `capability-prior.ts:160-172`).
- **Posterior = in-the-wild, per model** (P6).
- `effectiveCapability` blends them exactly as today: `(k·prior + n·rate)/(k+n)` (`route.ts:234-253`). The only change is that the `rate, n` now comes from `overlayByModel[modelKey][category][difficulty]` instead of `overlayByLane[laneId][category]`. The `priorStrength` (k) by rankings confidence (`capability-prior.ts:35-44`) is unchanged.
- **Lane-with-changed-model handled cleanly:** prior is re-resolved from the new model's snapshot row (P2 already does this via `resolveLaneModelId`), and posterior is read from the new model's key (P6). Both axes move together with the model. This is the clean version of the §0.3 bug.

A future option (note, not a Phase-1 requirement): collapse P2's overlay to be model-keyed too, so prior and posterior are literally the same key space. Phase 1 does not require it — resolving lane→modelKey at lookup time is enough.

---

## 4. Difficulty signal (content-free)

### Options evaluated

| Option | Cost | Signal quality | Content-free? | Verdict |
|---|---|---|---|---|
| (a) instruction token-length bucket | ~free (we already have `tokens_in`, `ledger.ts:84`) | weak (length ≠ hardness) | yes (integer bucket) | weak baseline |
| (b) P3-classifier complexity | free at classify time | classifier confidence is a *category* margin (`classify.ts:174`), NOT difficulty — would need a new signal | yes | not available today |
| (c) reviewer-assigned difficulty enum 1–3 | adds reviewer cost/latency, parsing risk | richest, human-ish judgment | yes (bounded enum) | best signal, real cost |
| (d) escalation-depth as implicit proxy | ~free (we already track it) | a task that needed rework/escalation was harder; structural, not subjective | yes (small int) | strong, cheap, already present |

### Decision (default): **(d) escalation-depth as the primary difficulty bucket, with (a) as a fallback floor.**

Rationale:
- We already record the escalation machinery: `action_taken` (`accept|rework|escalate|give_back`, `ledger.ts:52-53, 122`), the per-offload escalation stats (`ledger.ts:513-521`, `outcomeStats` at `ledger.ts:551-577`), and the escalation orchestrator counters (`run.ts:563, 568, 592-606`). Escalation depth is a *behavioral* difficulty proxy with zero extra reviewer cost and zero new content.
- It directly measures the product-relevant thing: tasks that needed escalation were the hard tail where misrouting lives (the explicit motivation in §0.4).
- Map to a bounded `DifficultyBucket` enum, e.g. `easy | moderate | hard` derived from the review *stage* at which the verdict was cast: stage 0 with a `pass` ⇒ `easy`; a `needs-rework`/`rework` round ⇒ `moderate`; an `escalate`/`give_back` ⇒ `hard`. The stage counter already exists (`run.ts:568 const stage = counters.reworks + counters.escalations`).
- (a) token-length bucket is recorded too (cheap, from `tokens_in`) as a coarse secondary so even single-shot accepts get *some* difficulty separation; used only when escalation depth is 0.

Reject (b) for Phase 1: the classifier emits no difficulty today; adding one is a separate research item. Hold (c) as an **operator decision** (§9) — it is the richest signal but adds reviewer cost and a parse surface; ship without it, add later if local data shows escalation-depth is too coarse.

**Confound to acknowledge (honesty bar, §5):** escalation-depth is **itself confounded**, not a clean difficulty oracle. A strict reviewer escalates work that a lenient reviewer would have passed, inflating "hard"; a lenient reviewer deflates it. The depth therefore mixes *task hardness* with *reviewer strictness* — the same strictness confounder §5 names for the verdict itself. It is still the best cheap, content-free, already-present proxy, and difficulty conditioning removes the **separate** confounder of "model only ever saw easy work." But the docs and `/why` must state plainly that the difficulty bucket reflects *the depth at which review escalated under this reviewer*, not ground-truth complexity. Reviewer-assigned difficulty (c) would replace one confounder (structural escalation) with another (the reviewer's subjective scale) — neither is ground truth, which is why (c) stays deferred.

### Schema placement

Add `difficulty?: DifficultyBucket` (a small enum) to **both** `TaskEventInput` and `OutcomeEventInput` and to both allowlists (`EVENT_FIELDS` `ledger.ts:136`, `OUTCOME_EVENT_FIELDS` `ledger.ts:146`). Defining `DIFFICULTY_BUCKETS` as a `readonly` enum list in `types.ts` (mirroring `TASK_CATEGORIES`, `types.ts:73-81`) and validating with the existing `requireEnum` helper (`ledger.ts:207`) keeps it strictly content-free. On the outcome event it is the cell key for learning; on the task event it supports difficulty-aware *cost* analysis later.

### Conditioned capability with shrinkage

Capability becomes `P(pass | model, category, difficulty)`:

- `outcomeCapability` accumulates into `[modelKey, category, difficulty]` cells (§3a).
- **Sparsity / shrinkage:** a `(model, cat, difficulty)` cell will often be thin. Use a back-off ladder inside the lookup: difficulty-cell → category cell (all difficulties) → declared/prior. Concretely, blend the cell's `{rate, n}` toward the *coarser* category-level observed rate before blending toward the declared prior, using the same shrinkage form already in `effectiveCapability` (`route.ts:234-253`). The existing `DEFAULT_PRIOR_STRENGTH = 8` (`route.ts:42`) governs how much evidence is needed to move; the decay-weighted `n` (`feedback.ts:138`) is the confidence mass. No cell with `n ≤ 0` ever moves the score (`route.ts:245-246`), so sparse cells are safe by construction.

---

## 5. Honesty (must be stated in code comments and `/why`, like F-1 already does)

F-1's own banner is blunt about this and P6 must keep that posture (`feedback.ts:14-19`, README at `README.md:298`): a review verdict is an **empirical adjustment, not a true model-quality estimator**. It is confounded by:

- **Reviewer strictness** — the verdict reflects *this reviewer model's* bar, not ground truth.
- **Selection bias** — lanes/models that win routing accrue more samples; losers stop getting fresh evidence (`feedback.ts:15-18`). Shrinkage toward the prior dampens but does not remove this.
- **Prompt quality** — a bad prompt can sink a good model.

**What P6 measures, stated plainly:** *"which model keeps passing MY/our reviews at difficulty D, in category C."* Difficulty conditioning removes **one** confounder (it stops crediting a model for only ever seeing easy work) — it does not remove reviewer strictness or selection bias.

**Selection bias mitigation (proposal, light):** acknowledge it explicitly in docs/`/why`; optionally add a small, opt-in exploration epsilon (occasionally route a non-winner to refresh its evidence). Phase 1 minimum: *acknowledge it* (matching the current honesty bar). Exploration is an operator decision (§9), not a Phase-1 requirement.

---

## 6. Cross-user flywheel (Phase 2) — the moat

### What is safe to aggregate

Only **aggregate counts**, never rows:

```
key:   (model_resolved, category, difficulty_bucket)
value: { pass: int, needs_rework: int, fail: int }   // plus a coarse decayed-n if useful
```

No `task_id`, no `attempt`, no timestamps finer than a coarse window, no `subject_lane_id`, no reviewer identity tied to a user, and **never** any prompt/code/diff text. These keys are all enums/ids/integers — the same content-free class the local ledger already guarantees (`ledger.ts:6-12`).

### Why this is the asset

Per-model × difficulty acceptance *across the whole user base* is:
- **Un-backfillable** — it accrues only from real, reviewed work over time; a competitor cannot synthesize it.
- **Self-updating** — when models churn (the exact `@latest`/repin churn from §0.3), the dataset re-centers on the new model automatically because the key is the resolved model id.
- **Difficulty-resolved** — the hard-tail acceptance per model is the column nobody else has and the one that actually predicts misrouting risk.

### Consent / privacy boundary

- **Opt-in only**, off by default — consistent with the local-first posture (`README.md:16-17`, "any hosted feature transmits only content-free, minimized payloads"). No data leaves the machine without an explicit, revocable opt-in.
- **Content-free guarantee at the aggregate boundary**, enforced the same way the ledger enforces it: an allowlist serializer for the upload payload (mirroring `serializeFields`/`OUTCOME_EVENT_FIELDS`, `ledger.ts:285-299`) so only the four-key/three-count shape can ever be transmitted.
- **Anonymization (aggregation alone is NOT enough — corrected):** the boundary is **aggregate-before-upload (counts only) + k-anonymity suppression + pseudonymous dedup**, not aggregation by itself. Specifically:
  - **Dedup / idempotency:** each contributor uploads a **snapshot** of its own aggregated tuples tagged with `(contributor_id, window_id)`. The server stores the **latest snapshot per `(contributor_id, window_id)`** — a re-upload **REPLACES** that contributor's prior snapshot for the window, it does NOT add. So re-uploads are idempotent; only **distinct contributors** are summed across the published cell. (Plain additive merge across the same contributor's re-uploads would double-count — that footgun is why replace-by-snapshot is required.)
  - **`contributor_id`** is an opaque, **rotatable** pseudonym used **server-side for dedup ONLY** — it is never part of the published leaderboard and never tied to identity.
  - **`users` = count of distinct `contributor_id`s** that contributed to a `(model, category, difficulty)` cell.
  - **k-anonymity suppression:** a cell is **withheld from the published chart until `users >= MIN_USERS`** (and a minimum total sample count) — per-model token sums and pass rates are NOT published for a thin cell, so no single contributor's usage can be inferred. (N=1 local charts are fine because they never leave the machine; suppression applies only to the *published cross-user* table.)
- **What must NOT leave the machine:** any per-task row, any text, any path, any secret, the raw ledger, reviewer notes (already never recorded, `review.ts:20` notes are host-only), and any field not on the upload allowlist.
- **ToS/privacy surface (be honest):** even content-free model-acceptance stats are *telemetry*; the consent copy must say exactly what is sent (model ids + category + difficulty + verdict counts) and let the user inspect a sample before enabling. This is an operator/legal decision (§9), not an engineering default.

Phase 2 is **designed here, built later** — only after Phase 1 produces real local data worth aggregating.

---

## 6.5 The public real-usage leaderboard (Phase 2 deliverable)

The operator's required Phase-2 output is a **benchmark-style leaderboard** — it *looks* like an AAII / SWE-bench leaderboard (one row per model, sortable columns, big numbers) but **every row is built from real, routed-and-reviewed, in-the-wild usage**, not a static eval. It is a pure aggregation over the content-free Phase-1 ledger; it invents no new data.

### Data source: a pure aggregation over the Phase-1 schema

The leaderboard reads **only** the Phase-1 content-free outcome events and rolls them up into one tuple:

```
key:   (subject_model_resolved, category, difficulty)         // all enums/ids — Phase-1 fields
value: {
  pass: int, needs_rework: int, fail: int,                    // verdict counts (from `verdict`)
  tokens_in_sum: int, tokens_out_sum: int,                     // from the joined task event's tokens
  users: int                                                    // contributing-user count (see N below)
}
```

Every input field already lands in Phase 1: `subject_model_resolved` (§2.1), `category` (`ledger.ts:111`), `difficulty` (§4), `verdict` (`ledger.ts:118`); token sums come from the task event's `tokens_in`/`tokens_out` (`ledger.ts:78-79`) joined by `(task_id, attempt)`. **There are no per-task rows and no text in the leaderboard — only counts and sums** — exactly the content-free class the ledger already guarantees (`ledger.ts:6-12`). The leaderboard is therefore a *view*, not a new event type.

### Per-model metrics shown (each row = one model)

1. **PERFORMANCE = review acceptance/pass rate, conditioned on difficulty.** The dogfood scale `(pass + ½·needs_rework) / (pass + needs_rework + fail)` — identical to F-1's `verdictValue` (`feedback.ts:40-45`) — computed **per difficulty bucket** so a model's easy-vs-hard pass rates are separate columns, not a blended average. (This is a pass-rate-at-difficulty, not a ground-truth capability — see the caveat below.)
2. **TOKENS USED, broken down PER DIFFICULTY LEVEL.** `tokens_in_sum + tokens_out_sum` for that model, shown per `easy | moderate | hard`, so the cost of getting that model's work *accepted at each difficulty* is visible (the hard tail's true price is the column nobody else publishes).
3. **CONTRIBUTING USERS (N).** The aggregate sample size behind the row — the number of distinct contributing installs that fed any event into it. N is shown **prominently next to every row** so a thin row (N=1, a handful of reviews) cannot masquerade as a robust benchmark. A row's verdict counts are also shown so the reader sees the raw evidence mass, not just a rate.

### Sortable by

- **difficulty level** (filter/group to one bucket and rank within it),
- **tokens-used-at-each-difficulty-level** (cheapest model that still passes at difficulty D),
- **model performance** (pass rate, optionally within a difficulty).

### Single-user → multi-user bootstrap (zero schema change)

The chart is **live at N=1** from the operator's own anonymized self-rating: the operator's local ledger already contains `reviewer_model`-cast outcomes plus (after Phase 1) `subject_model_resolved` and `difficulty`. Aggregating the operator's own ledger yields a complete leaderboard with `users = 1`. As opt-in users join, each contributor uploads its **already-aggregated** `(model, category, difficulty) → {counts, token sums}` tuples as a **snapshot tagged `(contributor_id, window_id)`** (see §6 anonymization). The server keeps the **latest snapshot per `(contributor_id, window_id)`** and the published cell sums **across distinct contributors**, with `users` = the count of distinct contributors in that cell. The transition needs **zero schema change** to the per-row tuple — N just grows from 1 to many. Cross-contributor summation is associative and commutative; **re-upload by the same contributor is idempotent because it REPLACES that contributor's snapshot rather than adding** (plain additive re-merge would double-count — the explicit footgun §6 guards against). Published cells are subject to the k-anonymity `MIN_USERS` suppression in §6.

### Where the chart is produced (Phase 2)

- **Local-first, no upload required for N=1:** a CLI command (e.g. `router_leaderboard` / `tmax leaderboard`) runs the pure aggregator over the local ledger and emits the table — rendered as text and/or **exported JSON** the operator can render in any chart UI. This is the *entire* Phase-2 deliverable for a single user; it transmits nothing.
- **Cross-user densification (upload, opt-in only):** the *same* aggregated tuple is uploaded through the §6 content-free allowlist serializer as a **per-`(contributor_id, window_id)` snapshot**; the server keeps the latest snapshot per contributor/window (replace-by-snapshot, §6) and the published table sums across **distinct contributors**, subject to the `MIN_USERS` k-anonymity suppression. The densified table is exported back as the same JSON shape. Upload is the **only** thing the opt-in gate controls; the local chart never needs it.

### Honest + content-free caveat (must be shown on the chart)

Display verbatim, alongside N: **"This measures who passes real reviews at difficulty D, not ground-truth capability."** It carries every §5 confounder (reviewer strictness, selection bias, the escalation-depth confound from §4) and is built **only** from aggregate counts/sums — never per-task rows, never text. N is shown so thin rows are visibly thin. The leaderboard makes no ground-truth claim; it is "who keeps passing *our* reviews, at what difficulty, for how many tokens, across N users."

---

## 7. Migration & back-compat

- **schema_version 1 → 2** (`ledger.ts:20`). New fields (`subject_model`, `subject_model_resolved`, `difficulty`) are all **optional**.
- **Old ledgers read unchanged.** `parseMeta` defaults missing `schema_version` to 0 (`ledger.ts:307-308`); legacy task backfill is untouched (`ledger.ts:323-333`); optional fields absent ⇒ omitted by the serializer (`ledger.ts:289`). F-1 and `summarize`/`tokenStats`/`outcomeStats` keep working: they never required the new fields.
- **Determinism preserved.** Model-keyed `outcomeCapability` is as pure and clock-injected as today (`feedback.ts:95-104`, `now` injected). Same inputs ⇒ same overlay.
- **Transition window (optional):** during rollout, the adapter MAY build *both* the lane-keyed (legacy) and model-keyed overlays and prefer the model-keyed one when a model key resolves, falling back to lane-keyed for outcomes that predate `subject_model`. Decide whether to keep the lane-keyed path long-term or retire it once model coverage is high (operator call).

---

## 8. Phased build plan + testing

Each phase is independently shippable and unit-testable. Core is pure, so the aggregation logic tests with `node --test` and no I/O — exactly how `feedback.ts` is tested today.

**Phase 1a — `subject_model` on the verdict.**
- Add fields to `OutcomeEventInput` + `OUTCOME_EVENT_FIELDS` + validation (`ledger.ts:104, 146, 253`).
- Populate in `review()` from `request.subjectLane.model` (+ canonicalize) (`review.ts:107-110`).
- Tests: serialize/parse round-trip drops nothing and adds nothing (content-free allowlist test, like existing ledger tests); `review()` writes `subject_model`; host-turn review leaves it absent; legacy outcome parses with `subject_model` undefined.

**Phase 1b — model-keyed F-1.**
- New `ObservedCapabilityByModel` type (`types.ts`), model-keyed `outcomeCapability` (`feedback.ts`), lane→modelKey resolution in the overlay lookup (`route.ts:269, 274, 285`).
- Adapter: `buildObserved` returns the model-keyed overlay (`packages/mcp/src/server.ts:242-252`); the escalation context (`run.ts`) passes it through unchanged in shape.
- Tests: a lane whose model changes does NOT inherit the old model's posterior; capability-0 opt-out still wins (re-use `route.ts:243, 307-309` invariants); absent overlay ⇒ byte-identical scores to declared; de-dup still holds per attempt.

**Phase 1c — difficulty bucket.**
- `DIFFICULTY_BUCKETS` enum (`types.ts`), `difficulty` on both event inputs + both allowlists + validation; derive the bucket from escalation stage (`run.ts:568`) / token-length fallback; condition `outcomeCapability` cells and add the back-off ladder in the lookup.
- Tests: bucket derivation from stage; sparse-cell back-off to category then prior; shrinkage math; content-free serialization of the enum.

**Phase 2a (later) — local leaderboard (§6.5), no upload.** The pure aggregator `(events) → {(model,cat,difficulty) → {pass,needs_rework,fail, tokens_in_sum, tokens_out_sum, users}}` plus the CLI/JSON exporter. Trivially unit-tested over synthetic ledgers (deterministic counts; the dogfood-scale pass rate matches `feedback.ts:40-45`); the chart is live at N=1 from the operator's own ledger. Transmits nothing.

**Phase 2b (later) — opt-in cross-user densification.** The §6 upload allowlist serializer (tested like the ledger's — only the counts/sums shape can serialize) + the **replace-by-snapshot server-side merge** (per `(contributor_id, window_id)`; tested: cross-contributor sum is associative/commutative, and re-upload by the same contributor is **idempotent because it replaces, not adds**) + the `MIN_USERS` suppression + the off-by-default consent gate. Same aggregated tuple as 2a; the densified table is the same JSON shape.

**Each phase independently shippable + testable.** Core is pure, so every aggregation tests with `node --test` and no I/O — exactly how `feedback.ts` is tested today. 1a/1b/1c each degrade to today's behavior when absent (§3c invariant c), so any one can ship alone; 2a ships on top of Phase 1 with no upload; 2b adds only the gated wire path.

**Gates that apply (every phase):** `typecheck`, `build`, `test`, and **`build:plugin`** — the MCP/plugin bundles are regenerated from core, and stale bundles are a known footgun (memory note "Commit all rebuilt bundles"; rebuild and stage **every** regenerated bundle after any core change).

**Worker assignment (see §10 for the full split):** implementation by cheap workers — **Grok (W1)** first, **Antigravity (W2)** as the second pass if W1's output fails review; **Claude is the last-resort fallback only** if both worker lanes fail Codex review. Codex reviews the hardest surfaces: the content-free allowlists, the model-keying invariants (§3c), and the leaderboard aggregate boundary (§6.5).

---

## 9. Risks & open operator decisions (the decision gate)

1. **Difficulty signal choice.** Default proposed: escalation-depth (d) + token-length fallback (a). *Decision:* accept this, or invest in reviewer-assigned difficulty (c) now?
2. **Reviewer-assigned difficulty (option c) — yes/no.** Richer signal, but adds reviewer latency/cost and a parse surface on the manager output (like `parseManagerVerdictStrict`, `review.ts:192-203`). Default: defer.
3. **Backfill old outcomes' model (§2.4).** Treat-as-unknown (default) vs read-time join-enrichment vs (discouraged) ledger rewrite.
4. **Keep the lane-keyed overlay during transition, or cut over hard?** (§7).
5. **Exploration for selection bias (§5).** Acknowledge only (default) vs add an opt-in epsilon-explore.
6. **Phase-2 consent/upload model (§6/§6.5).** The big one: opt-in copy, what exactly is sent, install-id vs anonymous merge, retention, and the ToS/privacy stance. Pure operator/legal call — engineering ships the content-free aggregator and the off-by-default gate; the *policy* is yours. Note: the **local** N=1 leaderboard (§6.5) needs no upload and no consent decision; only cross-user densification does.
7. **Privacy/ToS surface generally.** Even content-free telemetry is telemetry; confirm comfort before Phase 2b.
8. **Leaderboard surface (§6.5).** CLI table only, exported JSON only, or both? And the minimum N to *display* a row publicly (so thin rows are hidden, not just labeled)? Operator call.

---

## 10. Worker assignment for the eventual build

**Implementation ladder (cheap-first, Claude last):** route each bounded unit to the cheapest capable worker and only fall back up the ladder on a failed review.

- **W1 — Grok** (first attempt). Bounded, mechanical, pure-core, well-specified work: add fields + allowlist + validation (Phase 1a); the model-keyed `outcomeCapability` rewrite (Phase 1b); the difficulty enum + stage derivation (Phase 1c); the pure counts aggregator + CLI/JSON exporter (Phase 2a/§6.5). Delegate via `router_delegate` with the relevant files; pair `files:[]` + Codex review when dogfooding a blind worker (memory note "MiniMax worker profile").
- **W2 — Antigravity** (second attempt). If W1's output fails Codex review, hand the same bounded unit to Antigravity.
- **Worker-lane preconditions (verified):** Grok (W1) must be installed and available (else routing skips it). Antigravity (W2) ships **blocked by default** (`lanes.starter.yaml:125`, asserted by `registry.test.ts:415`) and must be explicitly enabled with its companion path configured before it can take work. Independently verify any worker's `npm run typecheck`/`build`/test claims (Antigravity self-reported a false PASS during P3). The W1→W2→Claude split below is **process guidance**, not a source-verified engineering fact.
- **Claude — last-resort fallback only.** Implement directly only if both W1 and W2 fail review on a unit. Reserve Claude's budget for the judgment-heavy, policy-sensitive surfaces that are *not* bounded boilerplate: the **Phase-2b upload / consent / anonymization boundary** (the opt-in gate, the wire-payload allowlist serializer, the consent UX) — keep these on **Claude / Codex** from the start.
- **What Codex should review hardest (the three highest-risk surfaces):**
  1. **Content-free invariant + the leaderboard aggregate boundary** — the allowlists (`OUTCOME_EVENT_FIELDS`, `EVENT_FIELDS`, and the Phase-2 upload allowlist) admit *only* ids/enums/integers, the serializer drops everything else (`ledger.ts:285-299`), and the §6.5 leaderboard emits **only** counts/sums/user-count — never a per-task row or any text.
  2. **Model-keying invariants** — capability-0 opt-out stays pre-overlay (`route.ts:243, 307-309`); reviewer/manager eligibility stays on *declared* lane capability (`route.ts:139-143`, `review.ts:221, 234, 242`); zero-change-when-absent (`route.ts:273-274`, `packages/mcp/src/server.ts:242-252`); a lane whose model changes does not inherit the old model's posterior (the core P6 correctness property).
  3. **Determinism + decay/de-dup** preserved in the re-keyed `outcomeCapability` (`feedback.ts:74-76, 119-122`), and the cross-user merge associative/commutative/idempotent.
