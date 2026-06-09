# Scope: Tandem routing — worker-first, full-access CLI steps in for repo-tight work

Status: **IMPLEMENTED** (Components A + C; B deferred) · Sprint worker: MiniMax-M3 · Reviewer: Codex (gpt-5.5)

> Build note: Components A (`access_need` gate + `auto`→`worker-ok` resolution) and
> C (`insufficient_context` give-back via the worker sentinel) are implemented and
> tested (579 tests pass, typecheck clean). Component B (`worker-first` strategy)
> stays deferred. The pure `access.ts` module was first delegated to MiniMax; its
> output leaked a `<think>` block and Codex (reviewer) rejected it, so Claude wrote
> it — the tandem give-back path working in practice.
>
> Codex code-review (round 2): "needs changes, no critical findings." Three fixes
> applied: (1) `escToOutcome` now carries the give-back reason on the escalation
> (`TOKENMAXED_ESCALATE`) path; (2) the worker recovery-retry token estimate in
> node.ts now includes `WORKER_SYSTEM_FRAMING` (parity with the reader path); (3)
> `parseGiveBackSignal` bounds the extracted need to the first line, capped at 200
> chars. Verified-correct by Codex: ledger honesty (`fallback` counts spend, claims
> no savings), F-1 hygiene (give-back never becomes a review `fail`), egress
> allowlist intact, preview/delegate parity.
>
> Codex review (round 4, after the `repo-tight` gate landed): four findings, all
> fixed. (1) `canDoRepoTight` narrowed — `agentic` API/local lanes are prompt-only,
> so only native + agentic CLI qualify; (2) the same gate now also filters
> escalation targets in `canReassign`; (3) the escalation `give_back` render
> preserves an insufficient-context need over generic manager text; (4) added MCP
> tests for `access_need` forwarding, preview repo-tight routing, and give-back
> rendering. 584 tests pass.

## 1. The ask (operator's words)

> "If something at our task is not repo or secret constraints, send it off to a
> worker where possible, like minimax — and have Claude or Codex jump in where a
> worker is needed with full access."
>
> "minimax3 for as much as possible, claude steps in for repo-tight tasks."

The request is a **routing constraint**: prefer a blind worker for as much as
possible; let a full-access CLI take over only when the task genuinely needs the
repo, tools, shell, or secrets.

## 2. What already exists (do NOT rebuild)

Reading the current router, most of this intent is already implemented:

- **Cost-biased preference toward workers.** `scoreLane()` in
  `packages/core/src/route.ts:226` applies `COST_PENALTY {local:0,
  subscription:0.05, metered:0.2}`. A subscription/local worker that is roughly
  as capable already outranks a metered full lane. The `tiered` strategy
  (`orderTiered`, route.ts:393) goes further: cheapest lane clearing a capability
  floor wins.
- **Full-CLI fallback for sensitive/private/secret work — an invariant for
  workers.** Two layers, and they matter for the security model:
  - *Policy* (`policy.ts:75`) is rule-first: an explicit rule decides the verdict,
    and only when no rule matches does the deny-by-default baseline
    (`policy.ts:86-95`) force-trusted anything not provably safe. A detected secret
    upgrades `allow` → `force-trusted` (`policy.ts:97-100`); the F-2 reader hard
    cap (`policy.ts:110-119`) is un-overridable. Policy *posture* can be loosened
    by user rules — **but only down to what the minimization layer permits.**
  - *Minimization* (`minimize.ts:267`) is the real floor: a worker payload is
    **hard-blocked, fail-closed, unless `repo_class=public` AND `sensitivity=normal`**
    — independent of any policy rule, and it gates the WHOLE request (instruction
    included, closing the "private code in the instruction" bypass). So
    private/sensitive → worker is an **invariant block**, not a mere posture: even
    a permissive policy rule cannot send private/sensitive content to a worker.
    (Readers have their own bounded carve-up via `minimizeForReader` + the F-2 cap;
    that is the only path private code legitimately egresses, and it requires
    explicit opt-in + attestation.)

  Net: "secret/sensitive/private-constrained → never a worker" is a guaranteed
  invariant, which is exactly why this scope leaves the egress model untouched and
  only adds an orthogonal *access* axis.
- **Worker minimization + egress gating.** `minimize.ts` scrubs and bounds the
  worker payload; worker/reader lanes only run once the gate is ready
  (`route.ts:96-99` workers; `:105-111` readers add `repo_read_attestation`).
- **Escalation on review failure.** `reassign.ts:141` escalates a failed/rework
  worker output up to a stronger lane, then gives back to the host.
- **Per-project preference.** `router_set_prefer` already lets the operator pin
  "route to MiniMax for now."

**Conclusion:** the secret/sensitivity axis of the ask is done. The gap is the
**repo axis** and the **explicitness** of the worker-first intent.

## 3. The actual gap

Three concrete holes between today's behavior and the operator's intent:

### Gap A — "repo-tight" is not a first-class signal (the core gap)
Today a task is steered to a full lane only via `policyContext` (repo_class /
sensitivity / secretHit). Note: attaching `files` to a delegate does **not**
steer routing — files land in the worker's scrubbed `taskInput`
(`server.ts:331-350`), not in `RouteContext`, so they change *what the worker
sees*, not *which lane is chosen*. A task can be
**repo-tight on a public, non-sensitive repo** — e.g. it needs to read many
files for context, run the test suite, use shell/tools, or make coordinated
multi-file edits. Policy's secret/sensitivity axis does not catch this, so such a
task can be routed to a blind worker and fail (or burn a review round-trip).

There is no field that says *"this subtask needs full repo/tool access — do not
attempt a worker."* The host (Claude) decides ad hoc whether to call
`router_delegate` at all, with no structured signal.

### Gap B — worker-first is not a declarable default
The operator intent "MiniMax for as much as possible" lives only in the host's
head or a manual `router_set_prefer`. There is no strategy/setting that expresses
*"bias hard toward worker lanes; only use a full lane when access-need or policy
demands it."* `maximize`/`tiered` approximate it via cost but don't encode the
intent as policy.

### Gap C — no graceful give-back when a worker is under-contexted
A blind worker that realizes mid-task it needs a file/tool it can't see has only
two outcomes today: guess (then fail review → escalate, C-13) or produce a wrong
answer. There is no clean *"insufficient_context, hand back to a full lane"*
signal. The user's "Claude jumps in where a worker is needed" is not a first-class
path — it is only reached via review failure, which costs a round-trip and is
charged as a quality failure rather than a context boundary.

## 4. Proposed feature

**"Tandem routing"** = an explicit access-need classification + a worker-first
default + a graceful give-back, built on the existing router (no rewrite).

### Component 1 — `access_need` on the delegate request (Gap A) — HIGHEST VALUE
The caller-facing field accepts three values; the **router only ever sees two**:

```ts
// On DelegateRequest (tools.ts:210) and router_delegate input (tools.ts:669-692):
access_need?: 'worker-ok' | 'repo-tight' | 'auto'   // default 'auto'

// On RouteContext (packages/core/src/types.ts) — RESOLVED, never 'auto':
access_need?: 'worker-ok' | 'repo-tight'
```

**`auto` is resolved BEFORE routing, not inside it.** `eligibleLanes`
(`route.ts:292`) and `routeDecide` receive only `task` (category) + `ctx` — they
have no `instruction` or `files`, so the heuristic cannot run there. The server's
delegate flow (`server.ts`, where `instruction`/`files` exist) calls
`inferAccessNeed(instruction, files)` to collapse `auto` → a concrete
`worker-ok`/`repo-tight` and puts the **resolved** value on `RouteContext`. The
router then treats it as a settled gate.

- `repo-tight` (resolved) → in **`eligibleLanes`** (`route.ts`) keep ONLY a lane
  that can actually act on the live repo: the native host lane or an **agentic CLI**
  lane (`canDoRepoTight` = `trust_mode==='full' && (native || (kind==='cli' &&
  execution_mode==='agentic'))`). `trust_mode: 'full'` is NOT enough, and neither is
  `agentic` alone — a full API/local lane (even if flagged agentic) only receives
  prompt + attachments over its executor and would blind-guess like a worker; only a
  spawned CLI can edit files / run commands locally. Such lanes (and all
  worker/reader lanes) are filtered out. When none qualify, `eligibleLanes` returns
  `[]` ⇒ `routeDecide` throws ⇒ `runTask` degrades to native (the host does it). The
  SAME gate is applied to escalation targets in `canReassign` (`reassign.ts`) so a
  repo-tight task is never escalated to a lane that can't act on the repo. This is a
  routing gate, NOT a policy verdict — policy stays about data egress; access is
  about capability. Do not put it in `isSelectablePreGate` — that function is
  lane/posture-only.
- **Preview/delegate parity:** because `auto` is resolved pre-routing,
  `router_preview` (`tools.ts:463-477`) currently takes only category/policy/gate
  and would diverge. Fix by giving preview the SAME resolution path — either (a)
  preview accepts `instruction`/`files` and runs `inferAccessNeed` identically, or
  (b) preview accepts an already-resolved `access_need` and the host passes what it
  will delegate with. (a) is truer to "preview reflects delegate"; (b) is cheaper.
  Pick one at implementation — flagged as a sub-decision, not left implicit.
- `worker-ok` → eligible for worker lanes as usual (policy still applies).
- `auto` (default) → a lightweight heuristic on `instruction` + `files` infers
  repo-tight: e.g. files attached AND instruction references running/testing/
  multi-file coordination/"the codebase"/tools. Heuristic is conservative — when
  unsure it picks `worker-ok` (cheaper) and lets review/give-back catch misses.
  Keep the heuristic pure + unit-tested; never silently override an explicit caller value.

The host-side `/route` skill is updated so Claude sets `access_need` deliberately
instead of inferring purely from whether it attaches files.

### Component 2 — `worker-first` strategy / default bias (Gap B) — DEFERRED
**Codex review: defer or drop.** For the stated operator goal ("MiniMax for as
much as possible") the existing `router_set_prefer` already pins MiniMax to the
front of eligible lanes (`route.ts:346-360`, wired in `server.ts:247-256`), and
the Component-A access gate handles the repo-tight carve-out. A new
`worker-first` strategy enum only earns its keep if the requirement becomes
"prefer *any* worker lane generically" (not MiniMax specifically) — at which
point: among lanes passing the access gate + policy, prefer any eligible worker
over any full lane above a capability floor, falling back to full otherwise,
ranking by trust tier (worker before full) then cost. Until that requirement is
explicit, **ship preference + access gate instead** and skip the third strategy.

### Component 3 — `insufficient_context` give-back (Gap C)
Add `insufficient_context` to the `FailureKind` taxonomy (`failure.ts:11-18`),
and a corresponding non-failure outcome path. When the worker explicitly says it
lacks needed files/tools (or the output is a refusal-for-context), the work
hands **directly to the host/full lane**.

Critical placement (per Codex): this does **not** live in
`escalationDecision()` — that function only sees a review verdict + counters
(`reassign.ts:141-156`) and cannot inspect lane output or failure kind. It
belongs in **`runWithEscalation()`** (`run.ts:488-565`), which sees the executor
result, plus rendering in `failure.ts` / `ledger.ts` / `tools.ts`. The
give-back must be recorded as a *context boundary*, NOT as a `fail` verdict — F-1
maps `fail=0` (`feedback.ts:40-44,61-70`), so reusing `fail` would wrongly
penalize the worker's learned capability (`effectiveCapabilityFor`,
`route.ts:216`). This needs **new schema values** — `TaskStatus` (`ledger.ts:23`),
`OutcomeAction` (`ledger.ts:43`), and possibly `ReviewVerdict` (`ledger.ts:27`)
do not yet carry a context-boundary value; add one rather than overloading
`give_back`/`fail`.

**Do not gate this behind `TOKENMAXED_ESCALATE`** — `runWithEscalation()` is
opt-in today (`server.ts:199-201,402-429`). Give-back is a safety behavior; it
must work on the default `runTask()` path too. Either lift the give-back check
into `runTask()` or make the server always route through a give-back-aware
wrapper regardless of the escalation flag.

This is the literal "Claude jumps in where a worker is needed" path.

## 5. Non-goals / explicit boundaries

- No change to the data-egress policy model (`policy.ts`) — secret/sensitivity
  gating stays exactly as is. Access-need is orthogonal (capability/access, not
  data trust).
- No new lane trust tier. Workers/readers/full are unchanged.
- No automatic repo-tight detection on the *worker side* (worker stays blind by
  design); detection is host-side (`auto` heuristic) + give-back.
- Heuristic must never *upgrade* a `worker-ok`/`repo-tight` explicitly set by the
  caller — explicit beats inferred.

## 6. Touch points (files)

| Component | File | Change |
|---|---|---|
| A: request schema | `packages/mcp/src/tools.ts:210` (`DelegateRequest`) | add `access_need` field |
| A: tool schema | `packages/mcp/src/tools.ts:669-692,713-722` (`router_delegate`) | accept + forward `access_need` |
| A: preview | `packages/mcp/src/tools.ts:463-477` (`router_preview`) | run same `auto` resolution OR accept pre-resolved `access_need` (parity sub-decision) |
| A: context | `packages/core/src/types.ts` (`RouteContext`) | add **resolved** `access_need: 'worker-ok' \| 'repo-tight'` (never `auto`) |
| A: gate | `packages/core/src/route.ts` (`eligibleLanes` + `canDoRepoTight`) | on `repo-tight` keep only native/agentic full lanes (NOT just `full`; NOT in `isSelectablePreGate`) |
| A: heuristic | new `packages/core/src/access.ts` | pure `inferAccessNeed(instruction, files)` for `auto` |
| A: wiring | `packages/mcp/src/server.ts` (delegate flow) | resolve `auto`→concrete via `inferAccessNeed`, then put resolved value on `RouteContext` |
| A: skill | plugin `/route` skill text | set `access_need` deliberately |
| C: failure kind | `packages/core/src/failure.ts:11-18` (`FailureKind`) | add `insufficient_context` |
| C: schema | `packages/core/src/ledger.ts:23,43,27` (`TaskStatus`/`OutcomeAction`/`ReviewVerdict`) | add context-boundary value (don't overload `fail`/`give_back`) |
| C: give-back logic | `packages/core/src/run.ts:488-565` (`runWithEscalation` + `runTask`) | detect `insufficient_context` → full lane; works WITHOUT `TOKENMAXED_ESCALATE` |
| C: outcome render | `packages/mcp/src/tools.ts:225-248,786` (`DelegateOutcome`/`renderDelegate`) | surface the give-back kind |
| ~~B~~ | _deferred_ | preference + access gate covers the goal; no new strategy enum |

## 7. Sequencing

1. **Component A** (access-need classification) — standalone, highest value, ships first.
2. **Component C** (give-back) — depends on A's vocabulary; safety net for `auto` misses.
   Note its larger blast radius: new schema values across `failure.ts`/`ledger.ts`
   and a placement in `run.ts` that must not depend on the opt-in escalation flag.
3. **Component B** (worker-first strategy) — **deferred/dropped** per Codex review;
   `router_set_prefer` + the Component-A gate already meet the operator goal.

## 8. Open questions — resolved by Codex review (2026-06-09)

1. **Routing gate vs. policy verdict** → RESOLVED: gate, as a filter step in
   `eligibleLanes` (not `isSelectablePreGate`, which reassignment reuses). Policy
   stays about data egress only.
2. **Component B worth a third strategy?** → RESOLVED: no. Defer/drop;
   `router_set_prefer` + access gate cover the operator goal.
3. **`auto` heuristic — host-side inference acceptable?** → RESOLVED by operator
   (2026-06-09): **`auto` → always `worker-ok`.** No heuristic — every untagged
   subtask tries a worker, and Component C give-back is the sole safety net for
   repo-tight misses. Chosen to maximize worker availability. Consequence:
   `inferAccessNeed` is trivial (`auto` ⇒ `worker-ok`); Component C is now
   load-bearing and must be built carefully. A caller may still pass an explicit
   `repo-tight` to skip workers up front; only `auto`/unset defers to give-back.
4. **`insufficient_context` as non-F-1 give-back correct?** → RESOLVED: yes — F-1
   maps `fail=0`, so a context refusal must NOT be recorded as `fail`. Requires a
   new context-boundary value in the ledger schema rather than overloading
   existing verdicts/actions.
