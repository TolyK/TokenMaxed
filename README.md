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

**v0 — early and incomplete.** The portable routing brain (`@tokenmaxed/core`)
is taking shape; the Claude Code plugin adapter, lanes, and the
minimization/policy gate are in progress. APIs will change. This is being built
in small, reviewed commits in the open — see the [Roadmap](#roadmap).

## Architecture

A portable core with thin adapters around it:

```
packages/
  core/     # the routing brain — pure, host-agnostic, no I/O, no network
            #   route   · decide the cheapest capable lane (pure function)
            #   registry· load locally-configured lanes
            #   price   · canonical savings math
            #   ledger  · append-only, content-free local event log
  plugin/   # the Claude Code adapter (commands, hooks, subagents) — WIP
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

## Getting started

> **Note:** v0 is early. There is not yet an end-user CLI or Claude Code plugin
> to install (those are on the [Roadmap](#roadmap)). Today you configure your
> lanes and drive the routing brain (`@tokenmaxed/core`) programmatically. The
> steps below show both.

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
commented schema. Only **trusted, non-API** lanes are selectable until the
minimization/policy gate ships — that ordering is enforced in code.

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
marked. Until the Claude Code adapter lands to record tasks automatically, the
ledger starts empty (the report says "No tasks recorded yet"); `tokenmaxed lanes`
works immediately off your `config/lanes.yaml`.

### Surfaces (where you can use TokenMaxed)

| Surface | Status | How |
|---|---|---|
| **CLI** (`tokenmaxed`) | available | the commands above, after `npm run build` |
| **Claude Code plugin** | in progress | installs as a plugin; records tasks + exposes `/router:*` commands |
| Other hosts (Codex, Gemini, Cursor, Kimi Code, Pi, …) | planned | same core, thin per-host adapters |

Setup is intentionally minimal: copy `config/lanes.example.yaml`, edit it, and
go. The Claude Code adapter will add a `/router:setup` wizard for the same config.

### Development

```bash
npm test         # run the test suite (TypeScript, no build needed)
npm run typecheck
npm run build    # emit JavaScript to packages/*/dist
```

## Roadmap

v0 is built locally first; a hosted dashboard is purely additive on top of the
same content-free event log.

- [x] **P1-S1** — Scaffold + pure `routeDecide`
- [x] **P1-S2** — Lane registry (`lanes.yaml`)
- [x] **P1-S3** — Pricing + canonical savings math
- [x] **P1-S4** — Append-only JSONL ledger + token stats
- [x] **P1-S5** — Token estimation + subscription-cap tracking
- [x] **CLI** — `tokenmaxed savings` / `tokenmaxed tokens`
- [ ] Claude Code plugin adapter (commands, hooks, trusted lanes)
- [ ] Minimization + policy gate (before any untrusted/API lane)
  - [x] Trust model (`trust_mode`, roles, `execution_mode`, manager eligibility)
  - [x] Policy engine (ordered rules + deny-by-default; routing filters by verdict)
  - [x] Minimizer (branded `MinimizedPayload` boundary + scrub + gitleaks fail-safe)
  - [x] Untrusted execution boundary (`executeUntrusted`) + egress-envelope CI

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
