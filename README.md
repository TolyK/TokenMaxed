# TokenMaxed

> Route every coding task to the **cheapest capable, policy-allowed lane** — local-first, content-free, and honest about what it saves you.

[![CI](https://github.com/TolyK/TokenMaxed/actions/workflows/ci.yml/badge.svg)](https://github.com/TolyK/TokenMaxed/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Status: v0 / early](https://img.shields.io/badge/status-v0%20early-orange.svg)](#project-status)

TokenMaxed is a router for coding agents. You already pay flat-rate for tools
like Claude Max and a ChatGPT/Codex subscription, and you may have a capable
model running locally. TokenMaxed spends that **already-paid, flat-rate capacity
first**, falls back to metered APIs only when it has to, and shows you — in real
dollars — what you *actually* spent and how much metered API cost you avoided (with
the all-frontier comparison kept as a clearly-labeled hypothetical, not the headline).

It is **local-first**: the routing brain, your prompts, and your code stay on
your machine. Any hosted feature added later transmits only content-free
metadata you explicitly opt into.

> **New here? Start with Claude Code →** [Use in Claude Code](#use-in-claude-code-plugin)
> — install the plugin, run `/tokenmaxed:setup`, done.

---

## Why

- **Subsidy capture.** Subscriptions are flat-rate; their marginal cost is ~$0
  until you hit caps. TokenMaxed defaults to that capacity before burning
  metered API dollars.
- **Data minimization (the moat).** Trusted lanes (Claude, Codex, local) can see
  your repo and tools. Untrusted lanes receive only a scrubbed, bounded,
  no-tool sub-request — never your repo, tokens, or paths.
- **Honest accounting.** The headline is the finance-grade number — what you
  *actually* spent and the metered dollars avoided; the all-frontier baseline
  (every task on the top model) is shown too but clearly labeled a *hypothetical*,
  never the headline. We never claim caps don't exist.

## Project status

**v0 — early but usable.** The portable routing brain (`@tokenmaxed/core`), the
data-minimization/policy gate + manager review, the `tokenmaxed` CLI, and the
**Claude Code plugin** are in place; broadening lane coverage and other host
adapters come next. APIs may still change. Built in small, reviewed commits in
the open.

## Architecture

A portable core with thin adapters around it:

```
packages/
  core/     # the routing brain — pure, host-agnostic, no I/O, no network
            #   route   · decide the cheapest capable lane (pure function)
            #   registry· load locally-configured lanes
            #   price   · canonical savings math
            #   ledger  · append-only, content-free local event log
  mcp/      # the MCP server exposing core to hosts (thin bridge)
  plugin/   # the Claude Code adapter: bundled server, /tokenmaxed:* skills, hooks
```

**Privacy invariant (absolute):** *No prompt or code content ever leaves your
machine to a TokenMaxed-hosted backend. Downstream model lanes receive only
minimized, policy-gated payloads.* The local event log is content-free by
construction (integers, enums, model ids — never text), which is also what lets
the local dashboard (`tokenmaxed dashboard`) be a pure forwarder — zero schema
changes and nothing leaving the machine.

## Requirements

- **Node.js >= 22.18** (the test suite runs TypeScript directly via Node's
  built-in type stripping, which is enabled by default from 22.18 — no extra
  test runner). A `tsc` build emits plain JavaScript for publishing/consumption.

## Use in Claude Code (plugin)

**👉 First time here? This is where to start.** Using TokenMaxed in Claude Code is
three steps: install the plugin, run `/tokenmaxed:setup`, then code as usual.
(Requires [Node.js ≥ 22.18](#requirements).)

### 1. Install the plugin

```bash
git clone https://github.com/TolyK/TokenMaxed.git && cd TokenMaxed
npm install
npm run build:plugin                   # bundle the self-contained plugin server
claude --plugin-dir packages/plugin    # load it into Claude Code for this session
```

> A marketplace install (`claude plugin install tokenmaxed@…`) ships with the
> first published release. Until then use `--plugin-dir` (add it to your Claude
> Code settings to load the plugin every session).

### 2. Run setup — once

Inside Claude Code, run:

```
/tokenmaxed:setup
```

It creates your config at `~/.tokenmaxed/lanes.yaml` and `policy.yaml` from
starter templates (it never overwrites an existing file), validates it, and
prints what's enabled and what to do next. **That's the whole required setup.**

### 3. Use it

**Just code as usual — there's no separate command to "run" TokenMaxed.** When a
step is a bounded, self-contained subtask (boilerplate, codegen, docs, a
mechanical refactor, an isolated bugfix), Claude offloads it to the cheapest
capable lane on its own, guided by the bundled `route` skill — it's Claude's
judgment call, not a background daemon, so you can also nudge it ("offload this
to a cheaper lane") or drive everything by hand:

| Command | What it does |
|---|---|
| `/tokenmaxed:setup` | create/validate config and show status |
| `/tokenmaxed:summary` | at-a-glance: 24h/7d/lifetime usage + metered $ avoided, your lanes + the active reviewer |
| `/tokenmaxed:savings [7d]` | savings from the local ledger |
| `/tokenmaxed:tokens [by lane]` | token usage (by model or lane) |
| `/tokenmaxed:why <category>` | preview which lane would handle a category — nothing runs |
| `/tokenmaxed:review` | manager review of your current working-tree changes |
| `/tokenmaxed:status` · `/tokenmaxed:on` · `/tokenmaxed:off` | show / enable / disable routing for this project |
| `/tokenmaxed:config [key] [value\|clear]` | show or persist the feature settings (`~/.tokenmaxed/settings.json`) — the durable alternative to launch-time env flags. An env var always overrides a stored setting; the kill-switch, YOLO, and API keys stay env-only. Hooks/statusline apply changes on their next run; routing flags apply at the next session. |
| `/tokenmaxed:prefer <lane>` · `/tokenmaxed:prefer off` | temporarily favor one configured lane (any vendor, CLI or API) over normal routing — e.g. to push a sprint's work to a cheaper subscription while another's credits run low; clears with `off`. Honored only when that lane is eligible, available, and capable for the task (else it falls back to normal routing). Persisted per project; no relaunch. |
| `/tokenmaxed:yolo` · `/tokenmaxed:yolo off` | **⚠️ dangerous** — turn YOLO mode on/off for this project (the `--dangerously-skip-permissions` analogue); see **YOLO mode** under optional features below. |

### Launch it (and turn on optional features)

Once the plugin is loaded and `/tokenmaxed:setup` has run, **you're done — just
code.** The three steps above are the whole required path. Offload is
*agent-driven*: Claude invokes the bundled `route` skill to hand a suitable
subtask to the cheapest capable lane via the `router_delegate` tool — the trusted
subscription CLI lanes enabled by default (Codex, the cheaper-Claude lane) work
with **no flags** (a local Ollama is an opt-in template — flip `blocked`→`full`
once a server is running). The plugin's hooks don't route on their own; they only gate delegation
when routing is off (a deterministic backstop) and run the turn-end review-iterate
loop (ON by default when a reviewer lane exists; opt out with
`TOKENMAXED_REVIEW_ON_STOP=false`). The env flags below switch on the other
*optional* features.

A worker lane's one weakness is that it's **blind to your repo** — it can
hallucinate plausible-but-wrong facts it can't see (a model price, an enum value,
a test-fixture idiom). To prevent that, `router_delegate` takes an optional
**`files`** list of repo-relative paths: they're read verbatim (server-side,
path-confined to the project), then scrubbed + size-bounded + policy-gated by the
minimizer, so the lane copies real values instead of inventing them. Private-repo
files only reach a **reader**-trust lane with reader egress enabled; otherwise
they're dropped and the reply says which and why. Still review offloaded output —
visibility fixes facts, not logic.

Every delegation that ran one or more lane legs returns an inline **receipt** —
tokens in/out (estimates labeled), real metered dollars spent, the estimated
metered dollars avoided, and how many legs ran (rework/escalation legs included;
a failed offload's spend is never hidden) — so you see what each offload cost
and saved as it happens, not only in the reports. (A delegation that never ran
a lane — e.g. routing degraded straight to native — has nothing to receipt.)

**Tandem routing (worker-first, full-access lane steps in for repo-tight work).**
Some subtasks genuinely need live repo/tool/shell access — running the test suite,
coordinated multi-file edits, broad cross-file reasoning — and no amount of
attached `files` makes a blind worker able to do them. Two mechanisms keep those
on a capable lane without giving up worker offload everywhere else:

- **`access_need`** on `router_delegate` (`worker-ok` | `repo-tight` | `auto`,
  default `auto`). `repo-tight` routes straight to a lane that can actually act on
  the repo — the **native host or an agentic CLI lane** (a full *answer-only* or
  remote-API lane is excluded; it would only get prompt + attachments) — and when
  none is available the task simply runs on the host. This is an *access* axis,
  orthogonal to the `repo_class`/`sensitivity` *data-egress* policy below.
- **Give-back.** Left on `auto`, every untagged subtask still tries a worker; a
  worker that finds it can't finish without context it was never given replies with
  a sentinel, and TokenMaxed hands the task back to the host (recorded honestly as a
  fallback — real spend counted, no savings claimed, and it never skews the learned
  capability scores). So the cheap path is tried first and the host steps in only
  when a worker actually hits a wall.

The optional features are opt-in **environment flags you set when you launch
Claude Code**. In the shell they go *before* `claude` (they're environment
variables, not CLI arguments):

```bash
# Plain — trusted subscription CLI offload (Codex, cheaper-Claude) works out of the box:
claude --plugin-dir packages/plugin

# Common "turn the safe extras on" launch: open the safety gate (needs gitleaks)
# so API/BYOK worker lanes and full API lanes can run. (The review-iterate loop is
# already ON by default when a reviewer lane exists — no flag needed; opt out with
# TOKENMAXED_REVIEW_ON_STOP=false. Reader lanes need MORE than the gate —
# TOKENMAXED_READER_EGRESS, per-lane attestation, a policy allow rule; see below.)
TOKENMAXED_GATE_READY=true \
  claude --plugin-dir packages/plugin

# Same, but also skip Claude Code's per-tool permission prompts (you trust the
# offloads to run unattended):
TOKENMAXED_GATE_READY=true \
  claude --dangerously-skip-permissions --plugin-dir packages/plugin
```

> ⚠️ `claude --dangerously-skip-permissions TOKENMAXED_GATE_READY=true` does **not**
> work: anything after `claude` is passed *to* Claude Code (here it'd be read as
> an opening prompt), not exported to the environment. Env assignments must
> **precede** the command, as shown above. (To persist them instead, `export` the
> vars in your shell profile or set them in your Claude Code env settings.)

Each flag is described under [Configure & extend](#configure--extend) below;
combine whichever you want on one launch line. Note: a **full CLI** reviewer
(e.g. Codex) needs no safety gate to run the (default-on) turn-end review; the
gate is needed only for API/BYOK egress.

#### Optional: a `tmax` shortcut (so you don't retype the flags)

Typing the env flags and `--plugin-dir` every launch gets old. Two pieces make
it a one-word command:

**1. Persist the flags.** The simplest way is TokenMaxed's own settings file —
run `/tokenmaxed:config gate_ready true` (and any other flag) once and it's
stored in `~/.tokenmaxed/settings.json`; env vars still override per launch.
Alternatively, persist them as env vars in your Claude Code settings
(`~/.claude/settings.json`). That file is **strict JSON** — no comments — so
add just the `env` keys:

```json
{
  "env": {
    "TOKENMAXED_GATE_READY": "true",
    "TOKENMAXED_ESCALATE": "true"
  }
}
```

(`TOKENMAXED_GATE_READY` opens the safety gate so API/BYOK egress is allowed — for
both worker/reader lanes and `full` API lanes; `TOKENMAXED_ESCALATE` reworks/escalates
offloads that fail review instead of shipping them unreviewed. The turn-end
review-iterate loop is **on by default** — no flag — so it isn't listed here; set
`TOKENMAXED_REVIEW_ON_STOP=false` to opt out, or `TOKENMAXED_REVIEW_MAX_ROUNDS` to
change the rework-round bound.)

**2. Alias the launch.** Pick **one** of these — the same word can't be both a
standalone command and an appended argument (in zsh the later definition wins):

```zsh
# (a) STANDALONE — type `tmax` alone, from any folder (recommended):
alias tmax='claude --dangerously-skip-permissions --plugin-dir /ABS/PATH/TO/packages/plugin'
#   →  tmax

# (b) APPENDED — a zsh GLOBAL alias you tack onto `claude` (`alias -g`, zsh-only):
alias -g tmax='--plugin-dir /ABS/PATH/TO/packages/plugin'
#   →  claude tmax
#   →  claude --dangerously-skip-permissions tmax
```

Use an **absolute** `--plugin-dir` path so it works from any directory. With the
flags in settings (step 1), every form above launches fully configured — gate
open, the turn-end review-iterate loop on (its default), and offloads escalated
rather than shipped unreviewed.
(`TOKENMAXED_GATE_READY` in global settings is inert until the plugin is loaded;
once loaded it affects `/tokenmaxed:why`/`setup` and gates **all** API/BYOK egress
— worker, reader, and `full` API lanes. Drop it from settings and prepend it
per-launch if you'd rather opt into the gate explicitly each time.)

### Configure & extend

- **Where config lives.** The plugin reads **user-owned** `~/.tokenmaxed/lanes.yaml`
  + `policy.yaml` — *not* the repo's `config/`, so a cloned repo can never
  introduce an executable lane. Edit `~/.tokenmaxed/lanes.yaml` to add or trust
  lanes: provider CLIs (Codex, Gemini, …), a local Ollama, the cheaper-Claude
  lane, or a BYOK worker. (The `tokenmaxed` CLI instead uses in-repo `config/`.)
- **BYOK API keys.** A BYOK `api` lane names an `authHandle`; put its key in env
  var `TOKENMAXED_KEY_<authHandle>` (e.g. `TOKENMAXED_KEY_OPENAI`). Keys are never
  stored by TokenMaxed.
- **Optional, off by default** (trusted CLI/local offloads work without either):
  - **Untrusted worker lanes** — install
    [`gitleaks`](https://github.com/gitleaks/gitleaks) and start Claude Code with
    `TOKENMAXED_GATE_READY=true`.
  - **Review-iterate loop (ON by default when a reviewer lane exists)** — at the
    end of a turn a trusted manager reviews **all** your changed code (tracked
    *and* untracked/new files; a very large/numerous untracked set is bounded for
    speed and any omission is flagged in the diff so a pass never reads as complete
    coverage); on a non-pass verdict Claude is told to rework and
    the change is **re-reviewed**, iterating until the reviewer passes. It is
    deterministic (a `Stop` hook — Claude can't forget to run it) and protected so
    the review *actually happens* without holding you up: a reviewer error/timeout
    doesn't pass silently — the review **re-fires (retries) on the next turn** until
    it succeeds, and the whole loop (reworks *and* retries) is **bounded** by
    `TOKENMAXED_REVIEW_MAX_ROUNDS` (default 5); only after that does it **yield**
    with the outstanding notes so even a persistent failure can't trap you. **Opt out** of
    reviewing entirely with `TOKENMAXED_REVIEW_ON_STOP=false` (or simply configure
    no reviewer lane — then nothing is reviewed). A **full CLI** reviewer (e.g.
    Codex) needs no safety gate; an API/BYOK reviewer needs `TOKENMAXED_GATE_READY=true`.
  - **Quality escalation** — when an offloaded result fails its manager review,
    retry it on a more capable lane (and ultimately give the task back to Claude
    rather than ship something that failed review); enable with
    `TOKENMAXED_ESCALATE=true`. The `router_delegate` outcome reports what
    happened ("accepted after rework", "accepted after escalation", a give-back
    when a reviewed result still failed, or — when no eligible manager is available
    — the result delivered **unreviewed**), and the per-offload escalation rate
    shows up in `/tokenmaxed:savings`.
  - **Learned capability** — let observed manager-review outcomes adjust routing
    over time; enable with `TOKENMAXED_LEARN_CAPABILITY=true`. Each lane's
    hand-assigned per-category `capability` score is treated as a **prior**; the
    recent pass/needs-rework/fail rate for that lane×category (recency-decayed,
    ~30-day half-life) shrinks it toward what's actually observed. A cheap lane
    that keeps passing earns more traffic; a once-best lane that starts failing
    loses it — and `/tokenmaxed:why` shows `(learned: declared 0.70, n=12)` when
    evidence moved a score. It moves slowly: the declared prior dominates until
    evidence accumulates (one or two reviews barely shift a score), an explicit
    `capability: 0` opt-out is never resurrected, and the config file is never
    modified (the adjustment is computed in memory from the ledger). Caveat: review success is an empirical
    signal, not a true model-quality measure (it's confounded by task difficulty
    and reviewer strictness), and lanes that win routing accrue more samples — so
    this is a useful heuristic, not unbiased benchmarking.
  - **Reader lanes (middle trust tier)** — a vendor you trust with your *code*
    but not your secrets/shell. A `reader` lane receives bounded, secret-scanned
    **repo-read** context (no secrets, no shell, no tools, answer-only) so
    repo-aware work can offload without marking the vendor fully trusted. This
    deliberately sends (possibly private) repo code to that vendor — secret egress
    is fail-closed and scanner-gated, *not* proven impossible, and the vendor's
    terms govern code once it's in the prompt — so it is **high-friction**:
    selectable only with **all** of `TOKENMAXED_GATE_READY=true` (the safety gate,
    needs gitleaks) + `TOKENMAXED_READER_EGRESS=true` (global),
    `repo_read_attestation: true` on that lane, an API/BYOK lane (reader execution
    is API-only), and a policy `allow` rule for the repo. Results are flagged
    *reader-derived* and must not be re-delegated to a worker. First-class vendor
    lanes (Gemini, Kimi, GLM, MiniMax) ship as safe `blocked` templates in
    `lanes.example.yaml` — you opt each one up deliberately. Note the executor
    constraint: **CLI** lanes can only be `full` (or `blocked`); `worker`/`reader`
    are **API/BYOK-only** (the certified executors are HTTP). So a CLI vendor is
    full-or-nothing, while an API vendor can be `worker`/`reader`/`full`.
  - **Plugin-backed CLI lanes (Grok, Antigravity)** — installed as Claude Code
    plugins (`grok-plugin-cc`, `antigravity-plugin-cc`), xAI Grok and Google
    Antigravity (Gemini) route like Codex: full-trust subscription CLI lanes, with
    token usage *estimated* (CLIs don't report exact counts). **Grok** ships enabled
    as a worker-only offload — availability-gated on the `grok` CLI, so `full` is safe
    by default; it never reviews. **Antigravity** is a worker *and* reviewer (a
    fallback after Codex in file order) but ships `blocked` in the templates because it
    must run through the plugin's companion script (it needs a PTY for headless output)
    at a machine-specific path — set `command`/`args` to that companion and flip to
    `full` to enable (see the `lanes.example.yaml` comments). Grok takes its prompt as
    an argv arg via the `{prompt}` placeholder; the Antigravity companion reads it from
    stdin via `--stdin`.
  - **Tiered routing (start cheap, step up)** — enable with `TOKENMAXED_TIERED=true`.
    Instead of maximizing capability, routing picks the **cheapest lane whose
    *effective* capability clears a floor** (`TOKENMAXED_TIER_FLOOR`, default 0.6;
    per-category overridable), so within a family (Haiku → Sonnet → Opus; minimax
    small → large) it **starts on the smallest model that's good enough** and **steps
    up** to a stronger same-family lane on a review failure (the escalation gate). Ties
    among floor-clearers break by cap-health, then real price (from the price table,
    so two subscription tiers are still distinguishable), then the lowest-capable lane
    that clears. A `capability: 0` lane is never selected; if nothing clears the floor,
    routing falls back to maximize so it never fails. `/tokenmaxed:why` shows the
    tiered pick. Family grouping uses each lane's `model_family`.
  - **⚠️ YOLO mode (the `--dangerously-skip-permissions` analogue)** — turns off
    the routing **permission gates** so EVERY configured worker/reader lane is
    selectable. Launch with `TOKENMAXED_YOLO=true` (session default), or flip it
    per project at runtime with `/tokenmaxed:yolo` (on) / `/tokenmaxed:yolo off`
    (the per-project setting overrides the env default and is persisted). When on,
    the router forces `TOKENMAXED_GATE_READY` and `TOKENMAXED_READER_EGRESS` open
    and **waives** the per-lane `repo_read_attestation`, the reader hard cap, and a
    `force-trusted` policy verdict — so a task routes to a worker/reader even on a
    private/sensitive/unknown repo. **This means (possibly private) repo code may
    be sent to any configured vendor lane.** Like `--dangerously-skip-permissions`
    still honoring deny rules, YOLO does **not** override two deliberate
    kill-switches — an explicit policy `block` rule and `disabledLaneIds` — and it
    does **not** disable the orthogonal protections that aren't routing permissions:
    the **secret scanner** still gates every payload (fail-closed), the lane/policy
    config is still read only from the user-owned `~/.tokenmaxed` (the RCE guard),
    and executor certification still applies. `/tokenmaxed:status` and
    `/tokenmaxed:why` show a loud warning while it's on. Only enable it on code you
    are comfortable sending to every lane you've configured.
  - Set `TOKENMAXED_DISABLE=true` to turn the whole router off (kill-switch)
    regardless of the flags above (including YOLO mode).

### Quota brain (never hit your weekly cap blind)

Declare what your plans actually enforce on any lane (all optional; see
`config/lanes.example.yaml`): `requests_per_window` (rolling 5h by default,
`window_ms` to override), `requests_per_week`, and/or `tokens_per_week`. Then:

- **Routing pressure** — as a lane's ROUTED share of its quota fills, routing
  deprioritizes it (warn at 70% used, critical at 90%); a capped lane can still
  win when it's the only capable one, and `/tokenmaxed:why` explains every
  quota-affected pick. An explicit `/tokenmaxed:prefer` deliberately overrides
  the pressure — loudly, never silently.
- **Honest depletion estimates** — a rolling-window-correct projection (it
  models consumption expiring out of the window, so a stable pace never fakes
  a depletion) that renders only with enough evidence: `est. ~2d at routed
  pace`, or just "approaching cap" when confidence is low, `now` when you're
  there. Never a calendar timestamp.
- **Overflow plans** — `/tokenmaxed:status` and `/tokenmaxed:summary` show,
  per near-cap lane, where its top categories would route with it excluded:
  `near cap: codex-cli — overflow: bugfix/codegen → claude-cli, docs → glm-api`.

Everything is labeled the **routed share**: TokenMaxed only sees what it
routed, so counts are floors on real usage, never totals — consistent with the
honest-accounting law.

### Statusline quota gauge (optional)

A one-line, always-visible gauge for Claude Code's status bar: estimated metered
dollars avoided (last 7 days) plus the tightest routed-5h request window among
lanes that declare `requests_per_window` (⚠ at 70% used, 🛑 at 90%). It reads
only the local lanes + content-free ledger — no probes, no network — and fails
silent, so it can never wedge the status bar. The 5h count is the **routed**
share of the window (ledger-only), never claimed as your total subscription
usage. Wire it up in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /ABS/PATH/TO/packages/plugin/statusline.mjs"
  }
}
```

### Model freshness (never silently run a stale model)

A lane's `model` is a pinned string, so it can drift stale as a vendor's family
advances (e.g. `minimax-m2` while the family reaches `minimax-m3`). TokenMaxed makes
that visible and gives you the choice:

- **Track the latest** — set `model: <family>@latest` on an **api** lane (e.g.
  `minimax@latest`). It resolves to the **newest model TokenMaxed can price** in that
  family, from the price table. Resolution is pure and adds **no network call** on the
  routing path; the shipped api vendor templates default to `@latest`.
- **Pin deliberately** — keep a concrete id (e.g. `minimax-m2`) to stay on a specific
  version; your choice is respected, never overridden. A pinned model that's **priced**
  in the table is still checked for staleness automatically (its family comes from the
  table metadata); for an unpriced or unknown-family pin, add `model_family: <family>`
  to the lane to enable the check.
- **Staleness is shown** — `/tokenmaxed:status` makes a one-time provider `/models`
  call (sends only the API key — no repo/task content), caches the result, and **warns**
  when a newer same-family model exists. The session-start summary then shows that
  warning from **cache only** (no per-launch egress). If the newer model isn't in your
  price table yet, the warning says so (a "pricing gap" — add its price to route it).
- **Price-table metadata** — `config/prices.seed.json` (schema_version 2) carries an
  optional `family` + `released` per model so `@latest` and staleness can order a
  family newest-first. CLI lanes (Codex/Gemini/Kimi) pin a concrete model the provider
  runtime selects — there's no model endpoint to auto-verify, so `@latest` is api-only.

## Getting started (CLI & core)

> Prefer the command line or your own integration? The steps below cover the
> `tokenmaxed` CLI (savings/token reports) and driving the routing brain
> (`@tokenmaxed/core`) directly. **Using Claude Code? See
> [Use in Claude Code](#use-in-claude-code-plugin) above — that's the fastest path.**

### 1. Install

```bash
git clone https://github.com/TolyK/TokenMaxed.git
cd TokenMaxed
npm install
npm run build    # compile @tokenmaxed/core so it can be imported by name
```

### 2. Configure your lanes

A *lane* is a way to run a task — a subscription CLI, a local model, or (later)
a metered API. Copy the example and edit it for your machine:

```bash
mkdir -p config
cp config/lanes.example.yaml config/lanes.yaml
```

Each lane declares its `kind`, `model`, `trust_mode`, `costBasis`, provenance,
and optional per-category `capability` scores in `[0, 1]`. See
[`config/lanes.example.yaml`](./config/lanes.example.yaml) for the full,
commented schema. **Trusted subscription CLI lanes (Codex, the cheaper-Claude lane)
are enabled by default; a local Ollama and untrusted worker (BYOK API) lanes ship as
opt-in `blocked` templates** — Ollama needs only a flip to `full` (plus a running
local server), while worker lanes also require opening the safety gate
(`TOKENMAXED_GATE_READY=true` with a secret scanner installed). That ordering is
enforced in code by the minimization/policy gate.

### 3. Route a task

```ts
import { routeDecide } from '@tokenmaxed/core';
import { loadLaneConfig } from '@tokenmaxed/core/node'; // file I/O lives in the Node adapter

// Load and validate your lanes (throws a clear error on a bad config).
const registry = loadLaneConfig('config/lanes.yaml');

// Decide which lane should handle a task of a given category.
const decision = routeDecide(
  { category: 'bugfix' },
  { lanes: registry.candidateLanes('bugfix') },
  {}, // policy — empty in v0
);

console.log(`${decision.laneId} — ${decision.reason}`);
// codex-cli — Selected codex-cli (gpt-5.5) for bugfix: capability 0.92 at subscription cost.
```

`routeDecide` is pure and deterministic: the same inputs always pick the same
lane, and `decision.scores` shows how every candidate ranked — exactly what
`/tokenmaxed:why` renders.

### 4. See your savings and token usage (CLI)

After `npm run build`, the `tokenmaxed` command reads your local, content-free
ledger (`~/.tokenmaxed/ledger.jsonl` by default) and reports on it:

```bash
npx tokenmaxed savings              # actual spend + metered $ avoided (headline) + baseline context + tokens
npx tokenmaxed tokens --by lane     # full per-lane token breakdown (--by model is the default)
npx tokenmaxed outcomes             # manager-review verdicts (pass/needs-rework/fail) + success rate per lane
npx tokenmaxed leaderboard          # real-usage per-model leaderboard (× category × difficulty), honest N
npx tokenmaxed leaderboard --html --open  # the same as a self-contained page (local view; nothing uploaded)
npx tokenmaxed dashboard --open     # the local dashboard: savings tiles, quota meters + forecasts,
                                    #   leaderboard, outcomes, recent offloads — ONE self-contained HTML
                                    #   file from your content-free ledger; no server, no network
npx tokenmaxed lanes                # your configured lanes: trust mode, autonomy, roles, manager eligibility
npx tokenmaxed savings --period 7d  # report commands take --period all|Nd|Nh
npx tokenmaxed help                 # full usage
```

```
TokenMaxed — savings (all time)

  Actual API spend $0.00 — saved $139.50 (100.0% of the frontier-equivalent cost)
  Baseline context: $139.50 avoided vs an all-frontier baseline (100.0%) — a hypothetical ceiling, not cash you'd otherwise have paid

  Lanes: claude-native ×1, codex-cli ×1, ollama-llama3 ×1
  Sensitive sends blocked: 0

  Tokens (usage, not $): 2,800,000 in / 1,300,000 out / 4,100,000 total
    claude-opus-4-7  2,000,000 / 1,000,000 / 3,000,000  (73.2%)  reported
    ...
  → full breakdown: tokenmaxed tokens
```

The headline is the honest, finance-grade figure — what you *actually* spent and
the metered dollars avoided — while the all-frontier baseline (every task on the
top model) is demoted to a clearly-labeled *hypothetical*, never the headline.
The token block is explicitly a usage count (not dollars), with estimated figures
marked. The ledger fills as you route tasks (via the Claude Code plugin below, or
your own `@tokenmaxed/core` integration); until then the report says "No tasks
recorded yet", while `tokenmaxed lanes` works immediately off your
`config/lanes.yaml`.

### Surfaces (where you can use TokenMaxed)

| Surface | Status | How |
|---|---|---|
| **CLI** (`tokenmaxed`) | available | the commands above, after `npm run build` |
| **Claude Code plugin** | available | `claude --plugin-dir packages/plugin`, then `/tokenmaxed:setup` |
| Other hosts (Codex, Gemini, Cursor, Kimi Code, Pi, …) | planned | same core, thin per-host adapters |

Setup is intentionally minimal: in Claude Code run `/tokenmaxed:setup`; for the
CLI, copy `config/lanes.example.yaml` and edit it.

### Development

```bash
npm test         # run the test suite (TypeScript, no build needed)
npm run typecheck
npm run build    # emit JavaScript to packages/*/dist
```

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) and
our [Code of Conduct](./CODE_OF_CONDUCT.md). For anything security- or
privacy-sensitive, see [SECURITY.md](./SECURITY.md).

Two rules are non-negotiable and enforced in CI as they land:
1. **No content → network.** Nothing derived from prompts or code may reach a
   network client.
2. **Honest savings.** Every savings figure carries its assumptions.

## License

[MIT](./LICENSE) © TokenMaxed contributors
