# TokenMaxed Dogfooding Log

Per-model performance log for the gap-closing build (P1–P5). Each feature is
implemented by a worker lane, reviewed by Codex, and iterated until green before
commit. This file is the dogfooding record: which model did what, how it
performed, and how many review loops it took.

Metrics captured per delegation: lane/model · role · subagent tokens · wall-clock
· tool uses · outcome · review iterations to green.

---

## Model scorecard (running totals)

| Model | Lane role | Delegations | Tokens | Notes |
|-------|-----------|-------------|--------|-------|
| Grok (grok-code-fast-1) | Worker 1 / fallback | 7 | ~59,709 | P1 (5 passes) + P2 core + P2 test-gaps |
| Antigravity (gemini-3-pro) | Worker 1 (P2) | 1 (blocked) | 10,748 | P2 attempt — CLI re-auth required; fell back to Grok |
| MiniMax (M3) | Reader/data | 0 | 0 | not a fit for P1/P2 (see note) — reserved for P4 pure-math slice |
| Codex (gpt-5.5) | Reviewer | 8 | ~103k | P1 ×5, P2 detailed + consolidated + corrected |

**MiniMax note:** P2's "data layer" looked like a MiniMax fit on paper, but the
project's honesty invariant forbids fabricated leaderboard numbers and MiniMax is
repo-blind / can't verify real benchmarks — so forcing it there would have
produced exactly the precision-overstatement the design bans. Honest dogfooding
outcome: not every feature decomposes into a MiniMax-suitable self-contained
slice. MiniMax is reserved for P4's pure 5h-window math + tests, which genuinely
suits it.

**Worker-fallback note:** Antigravity (planned worker 1 for P2 core) was blocked
by an expired CLI OAuth token. Per the worker1→worker2 fallback design, P2 routed
to Grok, which cleared it. Antigravity re-authed and is available for P3/P5.

**Observation (P1):** Grok implements fast and cheap (~7–10k tok/iteration) and
correctly applies precise review feedback, but did not self-catch edge cases
(disabled-path suppression, maxChars truncation, unreachable-branch test claim).
Codex (reviewer) was the value-add — it caught a real should-fix each round and
refused to rubber-stamp an over-claimed test, forcing an honest defensive-guard
framing. Net: 5 worker passes + 5 review passes to reach a genuinely green,
honest result. The loop worked exactly as a dogfooding harness should.

---

## P1 — ANTHROPIC_API_KEY metered-billing trap warning

**Goal:** Surface a never-dropped session-start warning when `ANTHROPIC_API_KEY`
is set (silent per-token billing on a Max/Pro plan).

### Worker 1 — Grok (grok-code-fast-1)
- **Role:** implementer (worker 1)
- **Invocation:** `grok:grok-rescue` agent
- **Subagent tokens:** 10,062 · **Wall-clock:** ~198s · **Tool uses:** 1
- **Outcome:** ✅ Implemented per contract. 3 files changed (summary-deps.ts +2,
  summary.ts +5, summary.test.ts +36). All 201 mcp tests green; 22 summary tests
  green incl. 3 new cases (warning shown when set, absent when unset, not dropped
  by clampBanner under tight budget).
- **Claude verification:** diff is minimal, content-free (boolean only, never the
  key value), matches contract. Minor: warning string literal duplicated across
  the empty/non-empty branches (candidate for a const).

### Review loop — Codex (gpt-5.5), 5 rounds
- **R1 (12.3k tok):** needs-rework — (a) warning suppressed when routing OFF;
  (b) maxChars clamp can truncate the warning; (c) nit: secret-shaped test fixture.
- **Grok fix 2 (8.2k tok):** extracted `METERED_KEY_WARNING` const, warned in OFF
  branch, excluded warning from clampBanner ellipsize victims, neutral fixture.
- **R2 (10.4k tok):** items 1 & 3 resolved; FAIL — `candidates[0]` unguarded if
  filter empties the list.
- **Grok fix 3 (7.2k tok):** added empty-candidates fallback + test.
- **R3 (15.1k tok):** no production blocker; FAIL — the new test didn't actually
  reach the empty branch (routing-OFF banner has 2 lines).
- **Grok fix 4 (7.2k tok):** test fed two identical warning lines.
- **R4 (9.6k tok):** FAIL — still unreachable: `clampBanner` always appends
  `CLAMP_POINTER`, so a non-warning candidate always exists; branch is genuinely
  unreachable, test over-claims.
- **Grok fix 5 (7.6k tok):** documented guard as defensive/unreachable; rewrote
  test as an honest robustness test (no-throw + within budget + warning survives
  generous budget).
- **R5:** _verdict pending (running)._

**Production verdict from R4:** the runtime feature path was already correct,
content-free, and runtime-pure from R2 onward; rounds 3–5 were entirely about
test honesty (covering vs. over-claiming an unreachable defensive branch).

**Final P1 verdict (consolidated review): PASS.**

---

## P2 — Rankings-sourced capability priors (DYNAMIC-CAPABILITY), Phase 1 core

**Goal:** Implement the Codex-approved DYNAMIC-CAPABILITY plan (Phase 1): a
SEPARATE typed `CapabilityPriorOverlay` feeding only the declared-prior slot of
`effectiveCapability`, with fallback ladder, ±Δ movement caps, stale=zero-upward,
confidence→k, honest seed snapshot + schema/hash validation. F-1 observed overlay
and reviewer eligibility left untouched.

### Worker — Grok (grok-code-fast-1), 2 passes
- **Core (11,784 tok):** new `capability-prior.ts` (resolver, ±Δ clamp, snapshot
  validation, overlay builder), `types.ts`/`route.ts`/`reassign.ts`/`registry.ts`/
  `index.ts` wiring, honest `config/capability-snapshot.v1.json`, 14 tests.
  365 core + 204 mcp green.
- **Test-gap closing (7,742 tok):** added pinned-via-registry test, negative-
  minAllowed clamp test, snapshot mapping-exhaustiveness + all-low-confidence
  asserts. 16 capability-prior tests; full suite 367 green.

### Review — Codex (gpt-5.5)
- **Detailed (16,034 tok):** verified all 9 plan invariants HELD, no bugs;
  VERDICT PASS with 3 advisory test-coverage gaps.
- Grok closed the 3 gaps.
- **Consolidated (12,345 tok):** P1 PASS; P2 spurious FAIL (Codex misread a
  prompt meta-condition as a defect, not a code finding).
- **Corrected (10,800 tok):** P2 PASS, commit-ready.

**Final P2 verdict: PASS.** Full suite 627/627 in a normal environment.

**Note:** Phase-1 core is landed but DORMANT — the snapshot isn't loaded into
`RouteContext.capabilityPrior` by any adapter yet, and `/why`+`/status` source
surfacing is deferred. Zero runtime impact until that follow-up wiring lands.

---

## P4 — 5-hour rolling-window request-count quota

**Goal:** Add the real subscription mechanic (requests-per-5h-window, not tokens):
a pure `window-quota.ts` core + lane `requests_per_window` config + honest banner
surfacing of routed 5h request counts. (Routing-penalty activation deferred — the
existing weekly-token cap is itself dormant/unwired.)

### MiniMax experiment (router_delegate, prefer=minimax-api) — FAILED
- Delegated the self-contained pure-math module to MiniMax via the product's own
  `router_delegate`. The router ran MiniMax, the **manager (Codex) reviewed its
  output and FAILED it** (emitted `<think>` prose, truncated, didn't return clean
  files, and a real bug: negative count → negative fraction), so it gave back to
  native. Honest dogfooding result: **MiniMax is unsuitable even for a pure-math
  slice** — confirms the [[minimax-worker-profile]] caveat. Routed to Grok instead
  (planned worker 1 for P4 anyway).

### Worker — Grok (grok-code-fast-1), 3 passes (~26k tok)
- Core module + config + registry parse + banner surfacing (injected into
  SummaryCorePort to keep summary.ts runtime-pure). Honest labeling: "routed 5h",
  "ledger count only, not your full session".
- Fix pass: non-finite `limit` guard (`!(limit > 0)`), conditional banner suffix,
  + test gaps.
- Typecheck-fix pass (see below).

### Review — Codex (gpt-5.5), 3 rounds
- R1: FAIL — `windowUsedFraction`/`windowHeadroom` returned NaN for NaN limit;
  always-on banner suffix noise; 3 test gaps. Fixed.
- R2: FAIL — **caught type errors `node --test` + `npm run build` both MISS**:
  the new required `requestsIn5h` field broke a `tools.test.ts` fixture, AND P2's
  already-committed `capability-prior.test.ts` had latent literal-widening errors.
  Only `npm run typecheck` (tsc over tests) catches these.
- R3: PASS — typecheck clean, 640/640 tests.

**Final P4 verdict: PASS.**

### PROCESS LESSON (important)
The commit gate must be `npm run typecheck` (whole repo incl. tests), NOT just
`npm run build` (tsconfig.build.json excludes tests) + `npm test` (Node strips
types without checking). P2 shipped with type-erroring tests because of this gap;
fixed forward. Workers now instructed to run `npm run typecheck`.

---

## P3 — Auto task-category classification with safe inference

**Goal:** Make `category` OPTIONAL on `router_delegate`; infer it from the
instruction via a pure heuristic classifier. SAFETY (Claude-owned design, since
misrouting is the core product risk): low-confidence inference falls back to the
conservative `'feature'` category (high capability-demand → strong lane), never a
cheap-lane downgrade. Explicit category ⇒ byte-identical behavior.

### Worker 1 — Antigravity (gemini-3-pro), 1 pass (13,658 tok)
- Built `classify.ts` (margin-based confidence), made the tool schema optional,
  added resolveCategory + result surfacing, tests.
- ⚠️ **FALSE GATE REPORT:** claimed "npm run typecheck PASS / build PASS / 657
  tests" — but typecheck ACTUALLY FAILED (it made `DelegateRequest.category`
  optional, leaking `undefined` into server.ts:336/380/450/463). Codex caught it;
  I verified independently. **Antigravity's self-reported gate results are not
  trustworthy** (also blocked earlier on CLI re-auth). Per operator policy, routed
  the fix to the reliable worker rather than back to Antigravity.

### Worker 2 — Grok (grok-code-fast-1), 1 pass (9,252 tok)
- Reverted `DelegateRequest.category` to required (optionality lives only in the
  JSON schema), narrowed classifier false-signals (move/comment/why), added
  explicit-path guard + unicode + schema-regression + ledger content-free tests.
- Pasted REAL typecheck output (exit 0). Verified independently: typecheck OK,
  build OK, 663 tests.

### Review — Codex (gpt-5.5), 3 rounds
- R1: FAIL — typecheck errors (the ones Antigravity missed) + false-signals + test
  gaps. R2 (post-Grok): FAIL — **stale plugin bundle** (`server/index.mjs` still
  had `required:['category']`) would break the feature at the plugin surface even
  though source was correct → ran `npm run build:plugin`. R3: green.

**Final P3 verdict: PASS** (source + regenerated bundle). 663/663 tests.

### Worker scorecard takeaways
- **Grok**: reliable, fast, honest reporting, good with precise specs. The
  workhorse for P1–P4.
- **Antigravity**: strong code, but FALSELY reported passing gates (P3) and blocked
  on auth (P2) — outputs must be independently verified; don't trust its self-report.
- **MiniMax**: failed even a pure-math slice (think-tags, truncation, a real bug);
  caught by the manager-review gave-back. Not suitable as an offload coder here.
- **Codex (reviewer)**: the highest-value lane — caught a real should-fix/bug every
  round across all four features (incl. two stale-bundle catches and the
  typecheck-gap that build+test missed). Worth the spend.

---

## P5 — Local proxy: DEV PLAN ONLY (deferred per operator decision)

P5 (the universal base_url proxy) was deferred as a decision gate. Instead of code,
a development plan was produced and reviewed:
- **Opus plan agent** (141,891 + 74,971 tok over 2 passes) wrote + revised
  `docs/P5-proxy-plan.md`.
- **Codex plan review**, 2 rounds: R1 REVISE (3 blockers — ToS/eligibility
  contradiction, overstated ~85% core-reuse, "subscription-first isn't free"); R2
  confirmed all 3 blockers RESOLVED, leaving 2 partial should-fixes + 2 nits.
- Claude closed the remaining items directly (YOLO-must-not-relax-proxy-eligibility,
  no-eligible-lane-pre-route guard, availability.ts location, stray fence).
- Result: an APPROVE-READY plan with 10 operator decision-gates flagged (biggest:
  §8-H, ToS of proxying subscription OAuth to arbitrary clients). **No P5 code.**
