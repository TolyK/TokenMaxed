# TokenMaxed

> Route every coding task to the **cheapest capable, policy-allowed lane** — local-first, content-free, and honest about what it saves you.

[![CI](https://github.com/TolyK/TokenMaxed/actions/workflows/ci.yml/badge.svg)](https://github.com/TolyK/TokenMaxed/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Status: v0 / early](https://img.shields.io/badge/status-v0%20early-orange.svg)](#project-status)

TokenMaxed is a router for coding agents. You already pay flat-rate for tools
like Claude Max and a ChatGPT/Codex subscription, and you may have a capable
model running locally. TokenMaxed spends that **already-paid, flat-rate capacity
first**, falls back to metered APIs only when it has to, and shows you — in real
dollars — how much you avoided versus running everything on the most expensive
frontier model.

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
- **Honest accounting.** Two numbers, never one: an *estimated* savings headline
  versus an all-frontier baseline, and a finance-grade *metered dollars avoided*
  figure. We never claim caps don't exist.

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
an optional web dashboard be added later as a pure forwarder, with zero schema
changes and nothing new leaving the machine.

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

Just code as usual: with routing on, Claude offloads bounded, well-specified
subtasks to the cheapest capable lane automatically. Or drive it by hand:

| Command | What it does |
|---|---|
| `/tokenmaxed:setup` | create/validate config and show status |
| `/tokenmaxed:savings [7d]` | savings from the local ledger |
| `/tokenmaxed:tokens [by lane]` | token usage (by model or lane) |
| `/tokenmaxed:why <category>` | preview which lane would handle a category — nothing runs |
| `/tokenmaxed:review` | manager review of your current working-tree changes |
| `/tokenmaxed:status` · `/tokenmaxed:on` · `/tokenmaxed:off` | show / enable / disable routing for this project |

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
  - **Turn-end review gate** — a trusted manager reviews your changes and can
    require rework before Claude finishes; enable with `TOKENMAXED_REVIEW_ON_STOP=true`.

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
commented schema. **Trusted CLI/local lanes are selectable out of the box;
untrusted worker (BYOK API) lanes stay disabled until you open the safety gate**
(`TOKENMAXED_GATE_READY=true` with a secret scanner installed) — that ordering is
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
lane, and `decision.scores` shows how every candidate ranked (useful for a
future `why` command).

### 4. See your savings and token usage (CLI)

After `npm run build`, the `tokenmaxed` command reads your local, content-free
ledger (`~/.tokenmaxed/ledger.jsonl` by default) and reports on it:

```bash
npx tokenmaxed savings              # estimated $ avoided + honest metered $ + token summary
npx tokenmaxed tokens --by lane     # full per-lane token breakdown (--by model is the default)
npx tokenmaxed outcomes             # manager-review verdicts (pass/needs-rework/fail) + success rate per lane
npx tokenmaxed lanes                # your configured lanes: trust mode, autonomy, roles, manager eligibility
npx tokenmaxed savings --period 7d  # any command takes --period all|Nd|Nh
npx tokenmaxed help                 # full usage
```

```
TokenMaxed — savings (all time)

  Estimated $139.50 avoided vs the all-frontier baseline (100.0% of frontier cost)
  Metered API — spent $0.00, avoided $139.50 (100.0%)

  Lanes: claude-native ×1, codex-cli ×1, ollama-llama3 ×1
  Sensitive sends blocked: 0

  Tokens (usage, not $): 2,800,000 in / 1,300,000 out / 4,100,000 total
    claude-opus-4-7  2,000,000 / 1,000,000 / 3,000,000  (73.2%)  reported
    ...
  → full breakdown: tokenmaxed tokens
```

The headline is always labeled *estimated vs the all-frontier baseline*, and the
token block is explicitly a usage count (not dollars), with estimated figures
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
