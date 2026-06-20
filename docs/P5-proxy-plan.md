# P5 — Local OpenAI/Anthropic-Compatible Proxy (Development Plan)

> **Status:** design only — NO code written, NO source modified. This is a
> decision-gate document: an engineer can execute it and an operator can
> approve/reject it. Several **open decisions (§8)** need the operator's call
> BEFORE coding begins.

---

## Revision log (v2)

Addresses a Codex `REVISE` review. All claims below were re-verified against the
cited source before editing.

1. **ToS gate is now the CONTROLLING Phase-1 rule (§8-H → §3.2 → §4.2).** The
   prior draft contradicted itself: it named subscription CLIs as the Phase-1
   default lane while §8-H required a per-lane attestation before any subscription
   CLI serves proxy traffic. Resolved in favor of the gate: **proxy eligibility
   defaults to LOCAL + explicitly-permitted programmatic API lanes ONLY.**
   Subscription CLI lanes do NOT appear in `/v1/models` or routing until a per-lane
   `proxy_serve` attestation exists (deferred). §3.2 and §4.2 rewritten to match.
2. **Reuse claim corrected (§2.2 / §2.5).** Dropped the "~85% reuse / proxy calls
   `runAndRecord` almost directly" framing. `runAndRecord` (node.ts:928-950) ONLY
   wires `runTask` deps + appends events — it does no availability probing, policy
   loading, model resolution, lane filtering, or recursion guarding; all of that
   lives in `makeServerDeps`/`delegate` in `server.ts`. `makeResolveAuth` is in
   `packages/mcp/src/config.ts:45`, NOT core. Replaced with a concrete
   build-it-yourself list and an honest ~50-60% reuse estimate.
3. **"Subscription-first inherits for free" removed (§3.2).** `COST_PENALTY` is
   only `{local:0, subscription:0.05, metered:0.2}` (route.ts:50-54) and
   `score = capability − cost·costPenalty − capPenalty` (route.ts:289-291) — a
   higher-capability metered lane CAN outscore a subscription lane. The proxy must
   apply EXPLICIT lane-eligibility filtering BEFORE `routeDecide`, then use
   `preferLaneId`/tiered within the allowed set.
4. **Should-fixes folded in:** gate-ready decision for full-API serving
   (§4.2/§8-H); accounting narrowed to "every ROUTED attempt produces a TaskEvent"
   with a content-free pre-routing-rejection note (§5/§6.1); native-lane fallback
   explicitly filtered out + `result.native`→503 with a test (§6.3/P5.1);
   robustness gates (size limits, loopback assert, no-bearer-forward, error shapes)
   moved into P5.1 baseline (§7); HTTP test lifecycle (start/stop + injected deps,
   bind 127.0.0.1:0 in-process) baked into the Phase-1 surface (§7).
5. **Nits:** pseudo-streaming latency/cancellation caveat inlined (§2.4); v1-ledger
   "mcp vs proxy traffic is unlabeled" caveat added (§5).

---

## 0. One-paragraph thesis

Today TokenMaxed routes coding subtasks **inside** Claude Code via the MCP tool
`router_delegate` (`packages/mcp/src/server.ts` → `delegate()` →
`@tokenmaxed/core` `runTask`). That makes it a *delegate* a single host pulls
from, not a *layer* other tools can point at. P5 adds a **local HTTP proxy**
(`packages/proxy`) that speaks the OpenAI `/v1/chat/completions` and Anthropic
`/v1/messages` wire formats, so ANY tool taking a `base_url` /
`ANTHROPIC_BASE_URL` (Codex CLI, Aider, Cline, Cursor, opencode, Gemini CLI,
Continue, and Claude Code itself) routes through TokenMaxed's cheapest-capable
selection **over the lanes the operator has authorized for proxy serving**. The
proxy is the universal integration primitive the MCP/delegation design leaves on the
table — but it forwards *whole conversations*, which breaks several assumptions the
bounded-delegate design relies on. Critically, the "spend a subscription before a
metered key" pitch that motivates a proxy runs straight into a **ToS gate** (§8-H):
serving arbitrary third-party clients off a subscription OAuth is exactly what those
providers may forbid, so Phase-1 defaults proxy serving to **LOCAL + permitted API
lanes only** and leaves subscription-CLI serving behind a deferred attestation. This
plan is honest about which bounded-delegate assumptions survive and which must be
relaxed, defaulted-safe, or explicitly opted into.

---

## 1. Goal & non-goals (Phase-1)

### In scope (Phase-1)
- A new workspace package `packages/proxy` exposing a **localhost-bound** HTTP
  server (default `127.0.0.1:8788`).
- **OpenAI `POST /v1/chat/completions`** — the lingua franca; the broadest client
  support (Aider, Cline, Continue, opencode, Cursor custom endpoints, litellm-style
  clients). Both non-stream and **SSE streaming** (`stream: true`).
- **Anthropic `POST /v1/messages`** — so `ANTHROPIC_BASE_URL=http://127.0.0.1:8788`
  points Claude Code / Anthropic SDK clients at the proxy. Non-stream + SSE.
- **`GET /v1/models`** — many clients call it on startup; return the lanes' resolved
  models so the client's model picker works.
- Routing through the **existing pure core** (`routeDecide` + the executors in
  `packages/core/src/node.ts`), reusing `makeServerDeps`-style wiring — NOT a second
  routing implementation.
- **Content-free ledger** entries for every proxied request, reusing `JsonlLedger`
  + the same `TaskEvent` shape so `/tokenmaxed:savings` and `npx tokenmaxed
  savings` account for proxy traffic alongside MCP traffic.
- **Safe-by-default trust posture**: proxy eligibility defaults to **LOCAL (Ollama)
  + explicitly-permitted programmatic API lanes ONLY**. Subscription CLI lanes
  (Codex, Claude, Grok, Antigravity) are NOT proxy-eligible in Phase-1 — they do
  not appear in `/v1/models` and `routeDecide` never sees them — because serving
  arbitrary third-party clients off a subscription OAuth may breach those
  providers' ToS in a way the in-Claude-Code MCP path does not (§8-H is the
  CONTROLLING rule, not a deferred footnote). Worker/reader lanes also stay off by
  default (§4). A subscription CLI becomes proxy-eligible only once the per-lane
  `proxy_serve` attestation gate exists (deferred, §8-H).
- Auth resolution **re-implementing** the `TOKENMAXED_KEY_<handle>` pattern (the
  proxy must build its own resolver; `makeResolveAuth` lives in
  `packages/mcp/src/config.ts:45`, NOT in core — see §2.5) and the user-owned
  `~/.tokenmaxed` config (the RCE guard).

### Explicitly deferred (NOT Phase-1)
- **Tool/function calling passthrough** (`tools`, `tool_choice`, `tool_calls`).
  Huge surface, and it interacts badly with minimization (a tool schema is repo
  structure). Phase-1 returns a clean error if a request *requires* tools on a lane
  that can't honor them, rather than silently dropping them.
- **Vision / multimodal / audio inputs.** Text-only Phase-1.
- **Embeddings, `/v1/completions` (legacy), images, moderations, files, assistants.**
- **`logprobs`, `n>1`, structured-output `response_format: json_schema`** beyond
  passthrough-or-error.
- **Multi-tenant / network-exposed serving, TLS, API-key auth ON the proxy.** It is
  a single-user localhost daemon. (Open decision §8 on whether to even gate it.)
- **Cross-conversation memory, caching, prompt-cache management.**
- **Mid-stream lane fallback.** If a streaming lane fails after the first byte, the
  stream ends with an error event — we do not silently re-route mid-stream.

The Phase-1 bar is **"compatible enough that the top clients work for ordinary
chat/coding turns,"** not full API parity.

---

## 2. Architecture

### 2.1 Where it sits
```
packages/
  core/    # unchanged — the pure brain + node executors (REUSE, do not fork)
  mcp/     # unchanged — the Claude Code delegate path
  cli/     # unchanged
  plugin/  # unchanged
  proxy/   # NEW — HTTP adapter: wire format ⇄ core. Thin, like packages/mcp.
```
`packages/proxy` is a **sibling adapter to `packages/mcp`**, with the exact same
relationship to core: it imports `@tokenmaxed/core` (pure) and
`@tokenmaxed/core/node` (executors, ledger, gitleaks scanner, auth). It adds the
one thing neither core nor mcp has: an HTTP listener and the OpenAI/Anthropic
**wire-format codecs**. New package `@tokenmaxed/proxy`, `bin: tokenmaxed-proxy`,
mirroring `@tokenmaxed/mcp`'s `package.json`. Use Node's built-in `node:http`
(zero new runtime deps; consistent with core's "no framework" posture) — Express
is unnecessary for a handful of routes.

### 2.2 Reuse vs rebuild — the honest, verified analysis

The reference flow is the MCP `delegate()` (`packages/mcp/src/server.ts:316-489`),
fed by `makeServerDeps()` (`server.ts:194-314`). **The prior draft overstated
reuse.** The key fact, verified: `runAndRecord` in core
(`packages/core/src/node.ts:928-950`) does almost nothing the proxy needs for free —
it ONLY assembles the `RunDeps` (executors + scanner + price table + `newId`),
calls `runTask`, and appends `result.events` to the ledger. It takes an **already
built** `RouteContext` and `Policy`. Everything that produces that `ctx`/`policy`,
and everything that makes routing safe, lives in `server.ts`/`config.ts`, NOT in
core's `runAndRecord`:

- **Availability probing** — `makeAvailabilityProbe(env)` + the
  `eligible → probeAvailable → availableLaneIds` dance (`server.ts:287, 380-382`).
- **Policy loading** — `makeLoadPolicy(env)` lives in `packages/mcp/src/config.ts`,
  not core.
- **Auth resolution** — `makeResolveAuth(env)` lives in
  `packages/mcp/src/config.ts:45-50`. Core's `runAndRecord` takes an INJECTED
  `resolveAuth`; it does not provide one.
- **Model resolution + priceability filter** — the `candidateLanes → resolveLaneModel
  → drop @latest → recordableLane` pipeline (`server.ts:300-314, 335-339`).
- **Recursion guard** — CLI children are spawned with `TOKENMAXED_DISABLE=1` via
  `makeCliSpawn()` so a cheaper-Claude lane can't re-enter routing
  (`server.ts:389-395`, comment at 208-210). The proxy must reproduce this or it can
  recurse into itself through a CLI lane.
- **`baseCtx` construction** — the gate/readerEgress/policyContext/access_need/yolo/
  tiered/preferLane block (`server.ts:353-379`) is hand-built in `server.ts`, not
  exposed by core.

| Concern | Where it lives today | Proxy Phase-1 | Verdict |
| --- | --- | --- | --- |
| `loadLaneConfig` / `loadPriceTable` | core (pure) | call directly | **REUSE** |
| `routeDecide`, `eligibleLanes`, `evaluate`, `classifyTask` | core (pure) | call directly | **REUSE** |
| `runTask` + executors + gitleaks scanner | core/node | call via `runAndRecord` | **REUSE the inner run+record** |
| `recordableLane` / `resolveLaneModel` priceability pipeline | `server.ts` (inline) | **must extract or duplicate** | rebuild/extract |
| `makeAvailabilityProbe` | `packages/mcp/src/availability.ts` | **proxy must wire its own probe** | rebuild (or extract) |
| `makeLoadPolicy`, `makeResolveAuth` | `packages/mcp/src/config.ts` | **proxy must build its own** (or move to a shared `core/node`-adjacent module) | rebuild/move |
| `baseCtx` builder (gate/prefer/tiered/policyContext) | `server.ts` inline | **proxy must build its own ctx** | rebuild (or extract) |
| Recursion guard (`TOKENMAXED_DISABLE=1` on CLI children) | `makeCliSpawn` wiring in `server.ts` | **proxy must replicate** | rebuild |
| **Lane-eligibility pre-filter** (proxy-eligible set, §3.2) | does not exist | **NEW** | new |
| **Wire-format codecs** (OpenAI/Anthropic in/out) | n/a | **NEW** | new |
| **SSE encoder** (§2.4) | n/a | **NEW** | new |
| **HTTP server + lifecycle** (start/stop, loopback bind) | n/a | **NEW** | new |

**Honest reuse estimate: ~50-60%.** The pure brain (`routeDecide` and friends) and
the inner `runTask`→record loop are genuine drop-ins. But the *plumbing that makes
routing correct and safe* — availability probing, policy/auth loaders, model
resolution, the recursion guard, and the `RouteContext` builder — is MCP-adapter
code the proxy must either (a) extract into a shared `core/node`-adjacent module, or
(b) re-implement. Plus four genuinely new layers (eligibility pre-filter, two
codecs, SSE, HTTP lifecycle).

**Decision gate (§8-D): do the extraction, or duplicate?** The highest-value
refactor is to lift the shared plumbing — `makeResolveAuth`, `makeLoadPolicy`,
`makeAvailabilityProbe`, the `resolveLaneModel`/`recordableLane` pipeline, and a
`baseCtx` builder — out of `packages/mcp` into a place both adapters import (e.g. a
new `@tokenmaxed/core/node` export surface or a small shared package). Core's
`runAndRecord` stays the inner run+record primitive both call AFTER they have built
the ctx. **Recommendation: extract** — two hand-rolled copies of the routing
plumbing will drift (the repo already has a documented "stale bundle" drift
footgun). P5.0 is exactly this extraction.

### 2.3 Request lifecycle (non-streaming)
1. HTTP request arrives at `/v1/chat/completions` (or `/v1/messages`).
2. **Decode** wire format → a normalized internal `{ messages, model?, stream,
   maxTokens?, temperature? }` (codec layer; never trusts client-named `model` as a
   lane — see §3).
3. **Flatten** the conversation into the single `instruction` string the core
   expects (`RunRequest.instruction`). Core/executors today take one prompt string
   (`combinedPrompt` in `node.ts:672`); the proxy collapses the message array into
   that, preserving roles as plain-text framing.
4. **Classify** to a `TaskCategory` (`classifyTask`) — but see §3 for why this is a
   weak signal here and what the default lane is.
5. Build `RouteContext` exactly as `delegate()` does (gate/availability/policy/
   prefer/yolo/tiered), set `policyContext` to the **conservative default** (§4).
6. `routeDecide` → lane. Run via the trusted executor (or worker/reader if opted
   in). Get `resultText` + reported usage.
7. **Encode** the result back into the requested wire format (OpenAI choices /
   Anthropic content blocks), synthesizing the fields clients require (`id`,
   `object`, `created`, `model`=the *executing* lane's resolved model, `usage`,
   `finish_reason`/`stop_reason`).
8. Append a content-free `TaskEvent` to the ledger (reuse).

### 2.4 Streaming (SSE) — the honest version
The internal executors (`makeTrustedApiExecutor`, `makeCliExecutor`,
`makeOllamaExecutor`, `executeUntrusted`) are **non-streaming today** — they
`await res.json()` and return one `resultText`. So Phase-1 streaming is a **wire
fiction**: TokenMaxed gets the full completion from the lane, then **re-emits it as
SSE chunks** to the client. This satisfies clients that *require* `stream: true`
(many TUIs hang on a non-stream response when they asked for stream) without
touching the executor contract.
- **OpenAI SSE:** emit `data: {chat.completion.chunk}` frames with
  `choices[].delta.content`, a final frame with `finish_reason`, then `data:
  [DONE]`. Chunk the buffered text into reasonable slices (e.g. token-ish or
  newline-ish) so progress UIs animate.
- **Anthropic SSE:** emit the documented event sequence — `message_start`,
  `content_block_start`, `content_block_delta` (text deltas), `content_block_stop`,
  `message_delta` (with `stop_reason` + usage), `message_stop`.
- **True end-to-end token streaming is deferred** to a later phase that adds a
  streaming executor variant in core/node (the executors would gain a
  `stream`-capable sibling that yields chunks). Phase-1 ships pseudo-streaming and
  **says so in the docs**. Two honest caveats to document inline (not just in §8):
  - **Latency-to-first-token == full-completion latency.** Because the lane runs to
    completion before the first SSE frame is emitted, the client sees no token until
    the whole answer is ready; the streaming is cosmetic. A client with a
    short *first-token* timeout (some TUIs abort if no byte arrives within N
    seconds) may give up before the buffered completion lands, even though a
    non-stream call would have succeeded.
  - **Cancellation is limited.** Client disconnect mid-stream cannot abort the
    upstream lane call — it has already completed (or is completing) before the first
    frame; the proxy can stop emitting frames but the spend/usage is already
    incurred and recorded. Document that cancelling a pseudo-stream does NOT save
    cost. (Open decision §8-E: is pseudo-streaming acceptable for v1, or is true
    streaming a launch blocker for the target clients?)

### 2.5 Auth / credentials
Two distinct credential axes, do not conflate:
- **Upstream lane creds** (the keys TokenMaxed uses to call vendors): the proxy
  needs the SAME `TOKENMAXED_KEY_<handle>` resolver, but `makeResolveAuth(env)` lives
  in `packages/mcp/src/config.ts:45-50`, **not in core** — so the proxy must either
  import it from a shared/extracted module (the P5.0 refactor, recommended) or
  re-implement the identical ~5-line namespaced-lookup function. A BYOK `api` lane
  names `authHandle`; the resolver maps it to `TOKENMAXED_KEY_<handle>` (rejecting any
  non-identifier handle ⇒ `''` ⇒ executor fails closed — preserve this exactly).
  Subscription CLI lanes (Codex, Claude, Grok, Antigravity) need no key, BUT per §3.2
  / §4.2 / §8-H they are **NOT proxy-eligible in Phase-1** — serving arbitrary
  clients off their OAuth is the unresolved ToS question. The subsidy-capture story
  (a client that would burn a metered key rides a subscription instead) is the
  *motivation* for the deferred `proxy_serve` attestation, not a Phase-1 default.
- **Downstream client auth** (the `Authorization: Bearer …` the *client* sends to
  the proxy): Phase-1 **ignores its value** (it is local-only) but should optionally
  require a shared token if the operator sets `TOKENMAXED_PROXY_TOKEN`, to stop a
  rogue local process from using the proxy. **Open decision §8-F.** Default:
  bind to loopback only, no token. NEVER forward the client's bearer to a vendor.

### 2.6 Config & state
Reuse the whole env surface from `makeServerDeps`: `TOKENMAXED_LANES`,
`TOKENMAXED_POLICY`, `TOKENMAXED_PRICES`, `TOKENMAXED_LEDGER`, `TOKENMAXED_GATE_READY`,
`TOKENMAXED_DISABLE`, `TOKENMAXED_READER_EGRESS`, `TOKENMAXED_TIERED`,
`TOKENMAXED_PREFER_LANE`, `TOKENMAXED_YOLO`, `TOKENMAXED_KEY_*`. New proxy-only:
`TOKENMAXED_PROXY_HOST` (default `127.0.0.1`), `TOKENMAXED_PROXY_PORT` (default
`8788`), `TOKENMAXED_PROXY_TOKEN` (optional), and the proxy-routing knobs from §3.

---

## 3. The hard tension: classifying & routing arbitrary inbound requests

This is the crux and where the category-based model **does not cleanly fit.**

### 3.1 Why the MCP model doesn't transfer
- The MCP `router_delegate` contract is "offload ONE bounded, self-contained
  subtask"; Claude *chooses* what to delegate and supplies a clean instruction. The
  proxy gets **whatever the upstream agent's harness emits** — a full multi-turn
  conversation, a giant system prompt, tool-result messages, the client's own
  scaffolding. There is no human/agent curating "this is a bounded codegen task."
- The 7-category taxonomy (`boilerplate|bugfix|refactor|explain|feature|codegen|
  docs`) was designed for coding subtasks. A chat/completions request may be none of
  these (a planning turn, a question, an agentic step). `classifyTask`
  (`packages/core/src/classify.ts`) keyword-matches and falls back to `feature`
  below `MIN_CLASSIFY_CONFIDENCE` (0.5) — fine as a *hint*, wrong as the *primary*
  routing axis for arbitrary text.
- Capability scores are **per-category**; routing without a trustworthy category
  routes on noise.

### 3.2 What the proxy's routing policy should actually be (recommendation)
Treat the proxy as a **capacity router over an explicitly-permitted lane set, not a
task classifier.** The honest framing: "serve this completion from the cheapest
capable lane the operator has *authorized for proxy serving*." The ordering matters —
**eligibility filtering happens BEFORE `routeDecide`, not inside it.** Concretely,
Phase-1, in this order:

1. **Build the proxy-eligible candidate set FIRST (the controlling step).** Before
   any scoring, intersect the usable lanes with the **proxy-serve allowlist**:
   - **LOCAL lanes (Ollama)** — always proxy-eligible.
   - **Programmatic API lanes whose ToS permits arbitrary-client serving** — eligible
     **only** when full-API serving is unlocked (`gateReady`, see §4.2) AND the lane
     carries an explicit proxy-serve permission (a `proxy_serve: true` lane field, or
     until that field ships, simply BYOK metered `api` lanes the operator has
     opted in).
   - **Subscription CLI lanes (Codex/Claude/Grok/Antigravity)** — **NOT eligible in
     Phase-1.** They are filtered out here so they never reach `routeDecide`, never
     appear in `/v1/models`, and never serve a proxy completion. They become eligible
     only when the deferred per-lane `proxy_serve` attestation exists (§8-H).
   - **Worker/reader lanes** — NOT eligible by default (§4).
   This is the load-bearing fix: the prior draft assumed "default to the cheapest
   subscription lane," which directly contradicts the §8-H ToS gate. The gate wins.
2. **Why filtering can't be left to `routeDecide` / `COST_PENALTY`.** Verified:
   `COST_PENALTY = {local:0, subscription:0.05, metered:0.2}` (route.ts:50-54) and
   `score = capability − cost·costPenalty − capPenalty` (route.ts:289-291). Cost is a
   *small near-tie nudge*, not a hard preference — a higher-capability metered lane
   **can and will outscore** a cheaper subscription lane (the code comment at
   route.ts:46-48 says exactly this: "a clearly more capable lane still wins"). So
   "subscription-first inherits for free" is FALSE. The proxy must enforce its lane
   policy as a pre-`routeDecide` filter (step 1); only WITHIN the surviving allowed
   set does the cost nudge + capability scoring decide the winner.
3. **Within the allowed set, steer with `preferLaneId` and tiered routing.**
   - **Default/primary lane:** reuse the existing preferred-lane mechanism
     (`preferLaneId`, applied at route.ts:427-435) — set it to the operator's
     designated proxy lane. It is moved to the front of `scores` *only if it survives
     the hard rails* (gate/policy/availability/capability>0), so it can never bypass
     the eligibility filter from step 1.
   - **Tiered routing fits generic traffic** (`strategy: 'tiered'`,
     `TOKENMAXED_TIERED`): "cheapest lane clearing a capability floor" is the right
     default for arbitrary completions. Recommend the proxy default to **tiered**
     even though the MCP path defaults to `maximize` (§8-B). This is what actually
     delivers "spend the cheap lane first" — NOT `COST_PENALTY` alone.
4. **Classification is advisory only.** Still run `classifyTask` to pick the
   per-category capability column (so a clearly-codegen request can favor a
   strong-at-codegen lane *within the allowed set*), but treat low confidence as "use
   the preferred/default lane," never as a reason to pick a weak lane. Surface the
   inferred category + confidence in `x-tokenmaxed-category` for transparency, like
   the MCP `categoryInferred`/`inferredConfidence` fields.
5. **Client-named `model` is a routing HINT, never a lane selector.** A client
   sending `model: "gpt-4o"` must NOT cause the proxy to call OpenAI gpt-4o — that
   would defeat routing AND bypass the eligibility filter. Phase-1 maps the client
   model to (a) a `model_family`/capability hint if it matches a known family, else
   (b) ignored, falling to the preferred/default lane. Document loudly: **the proxy
   decides the model, from the allowed set.** (Open decision §8-A — an explicit
   allowlisted passthrough escape hatch may come later, off by default, and even then
   only over proxy-eligible lanes.)

### 3.3 Honest limitation statement (for docs)
"The proxy routes by *available capacity and a coarse capability floor*, not by deep
task understanding. In Phase-1 it routes over **LOCAL + explicitly-permitted API
lanes only** — it is good at 'use a local/cheaper good-enough model instead of a
premium metered one.' The bigger 'spend my flat-rate subscription before my metered
keys' win requires serving a subscription CLI, which is gated behind the §8-H ToS
attestation and is NOT on by default. The proxy is NOT a substitute for an agent that
knows which subtask to hand off — that remains the MCP `router_delegate` strength.
Treat the proxy as a cost-aware default backend over your authorized lanes, not a
task dispatcher."

---

## 4. Trust & safety — the transparent-proxy problem, honestly

The bounded-delegate guarantees (minimize → scrub → secret-scan before any egress)
are **weaker on a proxy**, and pretending otherwise would violate the project's
honesty rule. Spell it out:

### 4.1 What changes vs the delegate path
- The delegate receives a *curated, bounded subtask*; the minimizer
  (`packages/core/src/minimize.ts`) caps it at 8 KB instruction / 64 KB per
  attachment / 192 KB total, scrubs paths/emails/URLs, and **blocks anything not
  `public + normal`** for a worker. A proxy conversation is none of those — it is an
  arbitrary, possibly huge, possibly secret-laden, possibly private-repo payload the
  client assembled.
- The minimizer would **block essentially all real proxy traffic** if applied as-is
  to a worker lane (deny-by-default: worker requires `public + normal`, and the proxy
  has no reliable `repo_class`/`sensitivity` signal — both default to `unknown` ⇒
  sensitive ⇒ blocked). That is the *correct* fail-closed behavior, and it means:

### 4.2 The safe default (recommended, fail-closed) — two independent gates

Phase-1 proxy eligibility is the **intersection of two filters**, both fail-closed:

**Gate A — trust tier (core's existing deny-by-default).** Only `full` (trusted)
lanes are admissible for proxy traffic; worker/reader lanes are NOT, because the
minimization story that justifies them assumes a bounded subtask the proxy cannot
provide. Enforce structurally with a **conservative `policyContext`** (default
`repo_class: unknown, sensitivity: unknown`) so `isSelectablePreGate` + `evaluate`
keep non-full lanes out exactly as they do today — **reuse the existing gate, do not
weaken it.**

**Gate B — proxy-serve permission (NEW, the ToS gate, §8-H — CONTROLLING).** Being a
`full` lane is necessary but NOT sufficient. A subscription CLI is a `full` lane,
yet serving arbitrary third-party clients off its OAuth is the unresolved ToS
question. So Phase-1 ALSO requires, on top of Gate A:
- **LOCAL (Ollama):** proxy-eligible (no third-party ToS concern).
- **Subscription CLI (Codex/Claude/Grok/Antigravity):** **NOT proxy-eligible.**
  Excluded by the §3.2-step-1 pre-filter — they never reach `routeDecide` and never
  appear in `/v1/models`. Re-enabled only via the deferred per-lane
  `proxy_serve: true` attestation.
- **Full API lanes:** see the gate-ready decision below.

> **The net effect (and the resolution of the prior contradiction):** Phase-1
> proxy serving defaults to **LOCAL + explicitly-permitted programmatic API lanes
> ONLY.** Subscription CLIs are off until the attestation gate ships. This is the
> CONTROLLING Phase-1 rule; §3.2 and §1 are written to match.

**Gate-ready decision for full-API serving (should-fix).** Verified: a `full` *API*
lane is selectable only when `gateReady` is true (route.ts:107-109 — for
`trust_mode: 'full'`, `return gateReady || lane.kind !== 'api'`), and MCP defaults
`gateReady` OFF (`server.ts:201-207`, `TOKENMAXED_GATE_READY === 'true'`). So full
API lanes are already gated off by default. **Decision: the proxy requires BOTH
`gateReady` (the existing minimization/secret-scan readiness flag) AND the new
proxy-serve permission before serving a full API lane.** Rationale: `gateReady`
attests "the safety machinery is built + a scanner is present" — exactly the
precondition for letting an API lane egress; reusing it avoids a parallel flag. The
proxy-serve permission is the *separate* ToS attestation layered on top. Do NOT
invent a third flag that bypasses `gateReady`.

**YOLO must NOT relax proxy eligibility (should-fix).** `TOKENMAXED_YOLO` forces
`gateReady` true (`route.ts:352`) and admits all `full` lanes pre-gate
(`route.ts:100`). That is acceptable for the operator's OWN interactive Claude Code
session, but the proxy serves *arbitrary external clients* — so the proxy's
eligibility/ToS pre-filter (§3.2: local + permitted-API only; subscription-CLI and
worker/reader gated) MUST be applied INDEPENDENTLY of `ctx.yolo` and must never be
bypassed by `TOKENMAXED_YOLO`. Concretely: the proxy builds its routing `ctx` with
`yolo` forced OFF for eligibility decisions (and applies its own allowlist BEFORE
`routeDecide`), so YOLO can never open a subscription/full lane to a proxy client.

### 4.3 If the operator opts worker/reader lanes in (high friction)
Only via explicit opt-in (new `TOKENMAXED_PROXY_WORKER_OK=true` AND the existing
`TOKENMAXED_GATE_READY` + a policy `allow` rule + gitleaks present), and even then:
- The **secret scanner still runs fail-closed** on every payload bound for a
  non-full lane (`secretGate` in `minimize.ts`) — this is the one egress control that
  *does* transfer cleanly and must never be bypassed (YOLO does not disable it; the
  proxy must not either).
- Because the minimizer blocks `unknown` context for workers, opting in is only
  useful if the operator also asserts `repo_class: public, sensitivity: normal`
  (e.g. a header `x-tokenmaxed-repo-class` the operator's own client sets, or a
  per-proxy config). This is an operator assertion, fail-closed if absent. Document
  that the proxy CANNOT verify this — it is a trust statement, like
  `repo_read_attestation`.
- **Honest egress statement (for docs):** "On a full lane the proxy forwards your
  whole conversation to a vendor you already trust. On a worker/reader lane (opt-in
  only) the secret scanner gates the payload, but minimization is far weaker than on
  a bounded delegate — the proxy cannot scrub an arbitrary conversation reliably.
  Treat worker/reader proxy egress as 'I'm willing to send this conversation to this
  vendor,' not as a no-leak guarantee."

### 4.4 What is enforceable vs not (the truth table)
- **Enforceable:** loopback binding; the **proxy-eligibility pre-filter** (LOCAL +
  permitted API lanes only — subscription CLIs and native/worker/reader lanes are
  removed before `routeDecide`); the deny-by-default trust gate (keeps non-`full`
  lanes out unless opted in); the secret scanner (fail-closed) on any non-full
  egress; the user-owned-config RCE guard (lanes/policy read only from
  `~/.tokenmaxed`); the `TOKENMAXED_DISABLE` kill switch.
- **NOT a hard guarantee (important correction):** "subscription-first" is NOT
  enforced by cost alone. `COST_PENALTY` (route.ts:50-54) is a small near-tie nudge;
  a higher-capability metered lane can outscore a cheaper subscription/local lane
  (route.ts:289-291). Cheap-first is delivered by the **eligibility filter + tiered
  routing + `preferLaneId`** (§3.2), not by `COST_PENALTY`. (And in Phase-1
  subscription CLIs aren't even eligible, so the relevant "cheap-first" is
  LOCAL-vs-metered within the permitted set.)
- **NOT enforceable / weaker:** reliable scrubbing of an arbitrary conversation;
  knowing a payload's true sensitivity/repo class; preventing a vendor from retaining
  prompt content under its own terms; the no-leak guarantee (it never applied to
  `full` lanes and is weaker for proxy workers).
- **Safe default that resolves it:** LOCAL + explicitly-permitted programmatic API
  lanes only (Gate A ∩ Gate B), until the operator deliberately opts into more.

---

## 5. Honest accounting — proxy traffic in the content-free ledger

The proxy sees full payloads but the **ledger stays content-free by construction**
— it reuses the existing `TaskEvent` shape (integers, enums, model ids, never text;
see `packages/core/src/ledger.ts` and `runAndRecord`). Concretely:
- **Scope of the accounting claim (narrowed, should-fix):** "**every ROUTED attempt
  produces a `TaskEvent`**," not every HTTP request. Verified: `TaskEventInput`
  (ledger.ts:67-101) REQUIRES `category`, `laneId`, `model`, `trust_mode`,
  `tokens_in/out`, the cost fields, and `policy_verdict` — a request that 400/422s
  **before routing** (malformed body, unsupported feature, no eligible lane, bad
  auth on the proxy) has no lane/model/category and therefore CANNOT form a
  conformant `TaskEvent`. Phase-1 does NOT log these pre-routing rejections to the
  ledger (they return a dialect-shaped error, §6.3). **"No eligible lane" MUST be
  detected by the proxy's own pre-filter BEFORE calling `runTask`** and returned as
  a dialect error — otherwise `runTask` synthesizes a native breadcrumb on no-route
  (`run.ts:142`/`:205`) which would (a) be persisted and (b) imply a host-agent
  fallback the proxy cannot offer. So the empty-eligible-set check is a pre-route
  guard, not a `runTask` outcome. A dedicated content-free
  rejection event (an enum-only `proxy_rejected` record) would require a schema bump
  and is explicitly deferred with the §8-C source tag.
- **v1-schema caveat (nit):** the v1 `TaskEvent` schema has **no field
  distinguishing MCP traffic from proxy traffic** — both append identical event
  shapes, so `/tokenmaxed:savings` and friends report the COMBINED total and cannot
  break it down by source until the optional `source: mcp|proxy` enum lands (deferred,
  §8-C). Document this so the operator doesn't expect a proxy-only line item in v1.
- Each ROUTED request produces one `TaskEvent` via the **same `runTask` →
  `result.events` → `JsonlLedger.appendTask`** path the MCP delegate uses
  (`server.ts:463-468`). No new ledger schema, no new fields → `/tokenmaxed:savings`,
  `npx tokenmaxed savings`, `npx tokenmaxed tokens`, and the session summary
  **automatically include proxy traffic** with zero changes (the README's
  "content-free local event log + future dashboard with zero schema changes"
  property holds).
- **Tokens:** use the lane's provider-reported `usage` when present (OpenAI/Anthropic
  return it; Ollama returns eval counts). CLI lanes (Codex/Grok/Antigravity) don't
  report exact counts → reuse the existing `estimateTokens` path and the
  `tokens_estimated: true` flag, exactly as the delegate path does. **Never claim
  exact counts the lane didn't give.**
- **Cost & savings:** reuse `computeCostPrimitives` / `priceForModel`. A subscription
  lane records `actual_cost = 0` and credits metered-avoided; a metered lane records
  real spend. The headline (actual spend + metered avoided) and the all-frontier
  baseline (clearly-labeled hypothetical) come out unchanged. The `recordableLane`
  guard must apply so an unpriceable metered lane never serves proxy traffic
  (else `runTask` throws after paying).
- **Provenance tag (optional, content-free):** consider adding a single enum field
  to distinguish `source: mcp | proxy` so the operator can see how much routing the
  proxy drove. This *is* a (tiny) schema addition — gate it behind §8-C; it is
  content-free (an enum) so it does not violate the invariant, but it does bump
  `SCHEMA_VERSION`. Default recommendation: **defer** — ship Phase-1 with no schema
  change, add the source tag in a later phase if the operator wants the breakdown.
- **Failures/blocks:** recorded honestly (status `failed`/`blocked`, `failureKind`)
  like the delegate path, so a blocked proxy request shows up in "sensitive sends
  blocked" rather than vanishing.

---

## 6. API-compatibility surface (Phase-1)

### 6.1 OpenAI `POST /v1/chat/completions`
- **Honor (drive behavior):** `messages` (system/user/assistant roles, text
  content), `stream` (→ §2.4), `stream_options.include_usage`.
- **Accept + map to routing hints (do not pass to vendor verbatim):** `model`
  (hint only, §3.2-5).
- **Accept + best-effort forward where the executor supports it:** `temperature`,
  `top_p`, `max_tokens`/`max_completion_tokens` — but note executors today send a
  fixed body (`node.ts:828`) and only inject `max_tokens` on the recovery retry.
  Phase-1 either (a) ignores these with a documented note, or (b) a small executor
  enhancement threads them through. Recommend **(a) ignore in Phase-1** to keep the
  executor contract untouched; revisit. (Open decision §8-G.)
- **Accept + ERROR if load-bearing, else ignore:** `tools`/`tool_choice`/
  `functions` (deferred §1), `response_format`, `n>1`, `logprobs`. If a client sends
  `tools` and clearly depends on them, return a structured `400`/`422` with an
  OpenAI-shaped error body explaining tools are not yet supported, rather than
  returning a toolless answer that breaks the client's loop.
- **Response:** synthesize `{ id, object:"chat.completion", created, model:
  <executing lane resolved model>, choices:[{index:0, message:{role:"assistant",
  content}, finish_reason}], usage }`. `finish_reason: "stop"` normally; `"length"`
  if the lane hit a length cap.
- **`GET /v1/models`:** list ONLY the **proxy-eligible** available lanes' resolved
  model ids (the §3.2 pre-filtered set — LOCAL + permitted API lanes; subscription
  CLIs, native, and worker/reader lanes are omitted) via the availability probe +
  `resolveLaneModel`, so a client never sees a lane the proxy would refuse to serve.

### 6.2 Anthropic `POST /v1/messages`
- **Honor:** `messages`, `system` (top-level string/array), `stream`, `max_tokens`
  (required by the Anthropic schema — accept and, per §8-G, ignore or thread).
- **Response:** `{ id, type:"message", role:"assistant", model, content:[{type:
  "text", text}], stop_reason:"end_turn", usage:{input_tokens, output_tokens} }`.
- **SSE:** the documented event sequence (§2.4).
- This endpoint is what makes `ANTHROPIC_BASE_URL` work. Call out explicitly that
  pointing Claude Code at the proxy lets *its* turns route too — but in Phase-1 those
  turns route only to **proxy-eligible lanes (LOCAL + permitted API)**; serving them
  off a Claude subscription lane is gated behind the §8-H `proxy_serve` attestation,
  not on by default.

### 6.3 Error / passthrough semantics
- **Shape errors in the requested dialect** (OpenAI `{error:{message,type,code}}` vs
  Anthropic `{type:"error", error:{type,message}}`) so clients parse them.
- **Map internal failure kinds** (`failure.ts`) to sensible HTTP codes:
  `auth_failed`→401, `bad_request`→400, `rate_limited`/`quota_exhausted`→429,
  `timeout`→504, `provider_error`→502, routing-disabled/no-lane→503 with a message
  pointing at `/tokenmaxed:setup`/config.
- **Never leak content in errors** — reuse the content-free error discipline already
  in the executors (`node.ts` returns `"untrusted lane request failed"` etc.).
- **No silent vendor passthrough, and no native fallback (should-fix).** Verified:
  `makeTrustedExecutor` returns `{ resultText: '', native: true }` for a native lane
  (node.ts:888-894), and a no-route degrades to a `status: 'native'` breadcrumb. The
  proxy has **no host agent to fall back to** — there is no Claude session driving it.
  Two-layer defense:
  1. **Filter native lanes OUT of the proxy-eligible candidate set** in the §3.2
     pre-filter, so a native lane is never even scored for proxy traffic.
  2. **Belt-and-suspenders at execution:** if a run nonetheless comes back with
     `result.native === true` (or a `no_route` native breadcrumb), the proxy maps it
     to a **dialect-shaped `503`** ("no capable lane available — see
     `/tokenmaxed:setup`"), never an empty 200 and never a metered-vendor fallback the
     operator didn't authorize.
  - **Test case (P5.1):** inject an executor/route outcome that yields
    `{ native: true }` and assert the HTTP response is a 503 with the correct
    OpenAI/Anthropic error body and an empty/absent ledger spend event (no phantom
    completion recorded).

---

## 7. Phased build plan (each phase shippable + testable)

The driving principle: **deterministic, network-free tests** by injecting the
executor + scanner + clock, exactly as core/mcp already do (`fetchImpl`,
`spawnImpl`, `scanSecrets`, `now` are all injectable).

**HTTP test lifecycle is part of the Phase-1 public surface (should-fix).** The
proxy package MUST expose `start(deps) → { url, close() }` (or equivalent
`createProxyServer(deps)` + `server.listen`/`server.close`) with **all collaborators
injected** (executor, scanner, clock, lane/policy/price loaders, auth resolver). The
server binds **`127.0.0.1:0`** in tests so the OS assigns an ephemeral port, tests
read the actual port back, drive it with `fetch`, then `close()`. This start/stop +
injected-deps contract is a P5.1 deliverable, not an afterthought — it is what makes
every later phase testable in-process with no network.

- **P5.0 — Refactor seam (no behavior change).** Extract the shared routing plumbing
  (`makeResolveAuth`, `makeLoadPolicy`, `makeAvailabilityProbe`, the
  `resolveLaneModel`/`recordableLane` pipeline, and a `baseCtx` builder) out of
  `packages/mcp` into a place both adapters import; core's `runAndRecord` stays the
  inner run+record primitive both call after building ctx (see §2.2). Tests: existing
  MCP suite stays green (proves no behavior change). *Independently shippable: yes —
  a pure refactor.* **(Or skip per §8-D and accept duplication.)**

- **P5.1 — OpenAI non-streaming chat/completions, proxy-eligible lanes only +
  baseline hardening.** New `packages/proxy`: `node:http` server with the start/stop +
  injected-deps lifecycle above, OpenAI codec, the **§3.2 eligibility pre-filter**
  (LOCAL + permitted API lanes; native + subscription-CLI + worker/reader excluded),
  routing via the shared helper with conservative `policyContext`, ledger recording
  for routed attempts, `GET /v1/models` (only proxy-eligible lanes). **Baseline
  hardening moved INTO P5.1 (not deferred to polish):**
  - **Loopback-bind assertion** — refuse to start bound to anything but a loopback
    host unless an explicit override is set; assert it in a test.
  - **Request size limits** — cap request body bytes; oversized ⇒ `413` in the
    requested dialect.
  - **No client-bearer forwarding** — the client's `Authorization` header is NEVER
    forwarded to a vendor; test that the upstream call carries only the lane's own
    resolved key.
  - **Unsupported-feature error shapes** — `tools`/`response_format`/`n>1` that are
    load-bearing ⇒ structured dialect-shaped `400`/`422` (not a silently-degraded
    200).
  - **`result.native` / no-lane ⇒ dialect-shaped `503`** (§6.3 test case).
  Tests: codec round-trip units; an end-to-end test with an **injected fake
  executor** asserting (a) `routeDecide` picked the expected lane from the eligible
  set, (b) OpenAI-shaped response, (c) a content-free ledger event for the routed
  attempt, plus the five hardening tests above.
  *Shippable: clients that do non-stream OpenAI work now, hardened from day one.*

- **P5.2 — OpenAI SSE (pseudo-stream).** Add the SSE encoder + `[DONE]`. Tests:
  parse the emitted SSE byte stream, assert frame sequence + reassembled content ==
  the buffered completion + `include_usage` behavior. Deterministic (buffered text →
  chunked).

- **P5.3 — Anthropic `/v1/messages` (non-stream + SSE).** Add the Anthropic codec +
  event sequence. Tests mirror P5.1/P5.2. *Shippable: `ANTHROPIC_BASE_URL` works.*

- **P5.4 — Remaining robustness & errors.** Builds on the P5.1 baseline (which
  already covers loopback bind, size limits, no-bearer-forward, unsupported-feature
  shapes, native→503). P5.4 adds the FULL failure-kind→HTTP mapping table
  (`auth_failed`→401, `bad_request`→400, `rate_limited`/`quota_exhausted`→429,
  `timeout`→504, `provider_error`→502) in both dialects, and the optional
  `TOKENMAXED_PROXY_TOKEN` shared-token check. Tests: each failure kind → expected
  status/body in each dialect; token present/absent/wrong → 200/401.

- **P5.5 (optional, gated) — Worker/reader opt-in for proxy.** Only if §8 approves.
  Wire the worker/reader path with the operator assertion header + the unchanged
  secret-scan gate. Tests: a payload with a planted secret → blocked (fail-closed);
  `unknown` context → blocked; explicit `public+normal` assertion → routes.

- **P5.6 (later, not Phase-1) — True streaming executor.** Add a streaming sibling
  to the API/Ollama executors in core/node that yields chunks; the proxy switches
  from pseudo to real streaming. Larger core change; out of Phase-1.

**Cross-cutting test strategy:** (1) codecs are pure functions → exhaustive unit
tests, no server; (2) routing is `routeDecide` → already covered in core, the proxy
only asserts it *calls* it correctly; (3) HTTP/SSE → in-process
server via the P5.1 start/stop + injected-deps lifecycle, bound to `127.0.0.1:0`
(ephemeral port), with a fake executor, asserting bytes; (4) a single real smoke test
(behind an env flag, not in CI) that points `curl`/the OpenAI SDK at a running proxy
with a real subscription lane. No network in the default suite — same discipline as
the rest of the repo (Node's built-in test runner, type-stripped TS, no extra
runner — see root `package.json`).

---

## 8. Risks & open decisions (operator must rule BEFORE coding)

- **§8-A — Client `model` passthrough.** Default: proxy ignores the client's model
  and routes itself. Decision: ship an opt-in allowlist that honors specific client
  models (escape hatch for "always use my Opus"), or keep routing fully in control?
  *Recommendation: routing in control for v1; allowlist later.*
- **§8-B — Proxy default strategy.** `maximize` (like MCP) or `tiered` (cheapest
  clearing a floor)? *Recommendation: tiered for the proxy — it matches "generic
  traffic, spend cheap" — even though MCP defaults to maximize.*
- **§8-C — Ledger `source: mcp|proxy` tag.** Adds a content-free enum but bumps
  `SCHEMA_VERSION`. *Recommendation: defer; ship Phase-1 with no schema change.*
- **§8-D — Do the P5.0 refactor, or duplicate?** *Recommendation: do the refactor —
  two routing code paths will drift (the project already has a "stale bundle"
  footgun habit).*
- **§8-E — Pseudo-streaming acceptable for v1?** Latency-to-first-token == full
  completion latency. *Recommendation: acceptable for v1 with a clear doc note;
  prioritize true streaming only if a target client visibly breaks.*
- **§8-F — Proxy-side auth token.** Loopback-only is the default guard. Decision:
  also require `TOKENMAXED_PROXY_TOKEN`? *Recommendation: optional, off by default;
  document the local-process risk.*
- **§8-G — Sampling params (`temperature`/`max_tokens`).** Ignore (keep executor
  contract) or thread through? *Recommendation: ignore in Phase-1; the executors
  send a fixed body today and threading them is a separate core change.*
- **§8-H — ToS of proxying subscription OAuth to arbitrary clients (CONTROLLING).**
  Routing a third-party client's traffic through your Claude Max / ChatGPT-Codex
  subscription via the proxy may violate those providers' terms in a way the
  *in-Claude-Code* MCP path does not (there, Claude Code is the sanctioned client).
  This is a **legal/policy call, not an engineering one — and in v2 of this plan it
  is the CONTROLLING Phase-1 rule, not a deferred caveat.** **Phase-1 decision (baked
  into §3.2 / §4.2 / §1):** proxy eligibility defaults to **LOCAL (Ollama) +
  explicitly-permitted programmatic API lanes ONLY** (full API + `gateReady` + an
  operator opt-in / future `proxy_serve` field). **Subscription CLI lanes are NOT
  proxy-eligible** — they are filtered out before `routeDecide` and never appear in
  `/v1/models`. A subscription CLI serves proxy traffic only once the per-lane
  `proxy_serve: true` attestation gate is built (deferred). Surface a loud warning in
  setup/status, mirroring how YOLO and reader-egress are surfaced. *The remaining
  operator decision is narrow: which (if any) BYOK API lanes to mark proxy-eligible,
  and whether to build the `proxy_serve` attestation that would re-admit a
  subscription CLI.*
- **§8-I — Scope of compatibility.** Confirm the target client list (Codex, Aider,
  Cline, Cursor, opencode, Gemini CLI, Continue, Claude Code) and that text-only
  chat/completions + messages is "compatible enough" for them. If any target hard-
  requires tool-calling, that pulls tool passthrough (deferred) into Phase-1.
- **§8-J — Security posture.** Loopback-only, content-free ledger, secret scanner
  on non-full egress, RCE-guarded config, no client-bearer forwarding. Confirm this
  is the accepted Phase-1 posture and that worker/reader proxy serving stays
  opt-in/off.

---

## 9. Worker assignment suggestion (for eventual implementation)

Grounded in the repo's worker profiles (MEMORY: MiniMax/reader blind-to-repo;
Grok worker-only; Antigravity worker+reviewer; Codex the strict reviewer):

- **P5.0 (refactor seam) → Claude (native) or Codex.** Touches the
  trust-sensitive `server.ts`/`node.ts` boundary; needs whole-repo reasoning and
  must not change behavior. *Repo-tight — keep on a full-access lane. Codex reviews
  hardest here.*
- **P5.1 / P5.3 (OpenAI + Anthropic codecs) → Antigravity (agy).** Self-contained,
  spec-driven wire-format translation with clear inputs/outputs and strong tests —
  ideal bounded codegen for a capable worker. Attach the relevant files
  (`node.ts` extract helpers, `ledger.ts` event shape) so it copies real
  signatures, not invented ones (the blind-worker footgun).
- **P5.2 (SSE encoder) → Grok or Antigravity.** Pure, deterministic
  buffered-text→frames logic; well-suited to a worker with a precise spec + a frame-
  sequence test to write against.
- **P5.4 (errors/robustness) → Antigravity, reviewed by Codex.** Mapping tables +
  edge cases; mechanical but security-relevant (no content in errors), so Codex
  review is mandatory.
- **P5.5 (worker/reader opt-in) → Claude/Codex only.** This is the
  trust-boundary-critical phase; it must not be offloaded to a blind worker.
  **Codex should review this hardest of all** — it touches the minimization/secret-
  gate egress story.
- **Codex review focus across all phases:** (1) the secret scanner is never
  bypassed for non-full egress; (2) the ledger stays content-free (no message text
  in any event/field/log line); (3) loopback binding + no client-bearer forwarding;
  (4) routing goes through `routeDecide`, never a second hand-rolled selection; (5)
  the conservative `policyContext` default actually keeps non-full lanes out.

---

## 10. Bottom line

P5 turns TokenMaxed from a Claude-Code-internal delegate into a **universal local
backend** any base_url-taking tool can use. It reuses the pure brain (`routeDecide`)
and core's inner run+record loop drop-in, but the routing *plumbing* (availability
probing, policy/auth loaders, model resolution, the recursion guard, the
`RouteContext` builder) currently lives in the MCP adapter and must be extracted or
re-implemented — honest reuse is **~50-60%**, plus four new layers (eligibility
pre-filter, two codecs, SSE, HTTP lifecycle). The category model doesn't transfer,
so the proxy routes as a **capacity router over an explicitly-permitted lane set**
(eligibility filter FIRST, then preferred-lane + tiered floor) — NOT relying on
`COST_PENALTY` for subscription-first, which the scoring code does not guarantee.
Minimization is fundamentally weaker on a transparent proxy, so trust is gated two
ways: core's deny-by-default keeps non-`full` lanes out, and the **§8-H ToS gate
(CONTROLLING) keeps subscription CLIs out** — Phase-1 serves **LOCAL + permitted API
lanes only**, with the secret scanner as the one egress control that survives intact.
The ledger stays content-free and every ROUTED attempt records a `TaskEvent`, so
accounting works with zero schema change (pre-routing rejections and an MCP-vs-proxy
breakdown are deferred). The decisive non-engineering gate is **§8-H** — the operator
clears it before subscription-CLI proxy serving ships.