/**
 * A-1 — stdio MCP server. THIN: it injects the core operations + config loaders,
 * builds the pure {@link createTools} list, advertises them, and routes CallTool
 * through {@link dispatch}. No routing/ledger logic lives here — all in core.
 *
 * This file (unlike tools.ts) DOES import `@tokenmaxed/core` by name at runtime;
 * that is fine because the server only ever runs after a build / as an installed
 * package where core's dist is present. Its logic is covered by the stdio smoke
 * test and the no-build tools.test.ts (which injects core via source).
 *
 * Config resolution (env overridable so the plugin can point at bundled paths):
 *   - lanes:  TOKENMAXED_LANES   (default ~/.tokenmaxed/lanes.yaml)
 *   - policy: TOKENMAXED_POLICY  (default ~/.tokenmaxed/policy.yaml)
 *   - prices: TOKENMAXED_PRICES  (default config/prices.seed.json)
 *   - ledger: TOKENMAXED_LEDGER  (default ~/.tokenmaxed/ledger.jsonl)
 *   - state:  TOKENMAXED_STATE   (toggle file; default ~/.tokenmaxed/state.json)
 *   - project key: TOKENMAXED_PROJECT (default "default")
 * Config is loaded lazily per call so the server starts even before setup, and
 * picks up edits without a restart. Loader errors become isError tool results.
 *
 * SECURITY: lanes + policy decide WHAT executes (cli commands / API endpoints)
 * and WHERE data may be sent, so they are read from a USER-OWNED location
 * (~/.tokenmaxed), never the project/repo dir. Otherwise a cloned malicious repo
 * could ship a `cli` lane with `command: sh` and a model-invoked offload would
 * run it. The project dir only contributes the toggle KEY (never executed).
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { TASK_CATEGORIES, eligibleLanes, evaluate, filterEventsSince, isManagerEligible, outcomeCapability, parseModelAlias, priceForModel, resolveLaneModel, routeDecide, runTask, runWithEscalation, summarize, tokenStats } from '@tokenmaxed/core';
import type { EscalationDeps, EscalationResult, Lane, LaneRegistry, ObservedCapabilityByLane, PriceTable, RunDeps, TaskCategory } from '@tokenmaxed/core';
import {
  JsonlLedger,
  executeReader,
  executeUntrusted,
  laneToReaderDTO,
  laneToUntrustedDTO,
  loadLaneConfig,
  loadPriceTable,
  makeCliExecutor,
  makeGitleaksScanner,
  makeTrustedApiExecutor,
  makeTrustedExecutor,
} from '@tokenmaxed/core/node';

import { makeAvailabilityProbe } from './availability.ts';
import { reportFreshness } from './freshness-report.ts';
import { readFreshnessCache, writeFreshnessCache } from './model-cache.ts';
import { fetchModelList } from './model-list.ts';
import { makeSummaryFromEnv } from './summary-deps.ts';
import { homeFile, makeCliSpawn, makeLoadPolicy, makeResolveAuth } from './config.ts';
import { makeHostReviewDeps, makeReviewRunner } from './host-review.ts';
import { runReviewWithBudget } from './review-budget.ts';
import { runSetup } from './setup.ts';
import { createTools, dispatch } from './tools.ts';
import { readEnabled, writeEnabled } from './toggle.ts';
import type { ToggleStore } from './toggle.ts';
import type { CorePort, DelegateOutcome, DelegateRequest, ReviewOutcome, ToolDef, ToolDeps } from './tools.ts';

// User-owned (NOT repo-controlled) — see the SECURITY note above. HOME_TM and the
// auth/spawn helpers come from config.ts so they have one shared definition.
const DEFAULT_LANES = homeFile('lanes.yaml');
// Price seed shipped WITH this package, resolved module-relative (not cwd) so a
// standalone `tokenmaxed-mcp` and the esbuild bundle both find it without env.
// (../prices.seed.json sits next to dist/ in the package and next to server/ in
// the plugin bundle.) reference data only — no execution.
const DEFAULT_PRICES = fileURLToPath(new URL('../prices.seed.json', import.meta.url));

/**
 * Whether a lane can actually be used for an offload: a METERED lane whose model
 * is absent from the price table can't be cost-recorded (runTask would throw after
 * paying for it), so it's excluded from routing. Subscription/local lanes cost
 * nothing to record (actual_cost 0) and need no price entry. Applied to BOTH
 * preview and delegate so /tokenmaxed:why never advertises a lane delegate refuses.
 */
function recordableLane(lane: Lane, priceTable: PriceTable): boolean {
  if (lane.native || lane.costBasis !== 'metered') return true;
  try {
    priceForModel(priceTable, lane.model, { tokens_in: 0, tokens_out: 0 });
    return true;
  } catch {
    return false;
  }
}

/** Map a C-13 EscalationResult onto the adapter's DelegateOutcome for rendering. */
function escToOutcome(esc: EscalationResult, modelOf: (laneId: string) => string | undefined, recordingFailed: boolean): DelegateOutcome {
  const r = esc.result;
  const model = modelOf(r.laneId);
  const base: DelegateOutcome = {
    laneId: r.laneId,
    status: r.status,
    ...(r.native ? { native: true } : {}),
    ...(r.resultText !== undefined ? { resultText: r.resultText } : {}),
    ...(model ? { model } : {}),
    ...(r.failureKind ? { failureKind: r.failureKind } : {}),
    ...(r.readerDerived ? { readerDerived: true } : {}),
    ...(recordingFailed ? { recordingFailed: true } : {}),
  };
  switch (esc.final_action) {
    case 'give_back':
      return { ...base, native: true, reason: `manager review (${esc.verdict ?? 'fail'})${esc.notes ? ` — ${esc.notes}` : ''}` };
    case 'review_unavailable':
      return { ...base, reviewUnavailable: true, ...(esc.reason ? { reason: esc.reason } : {}) };
    case 'accept_after_escalation':
      return { ...base, reason: 'after escalation' };
    case 'accept_after_rework':
      return { ...base, reason: 'after rework' };
    default:
      return base; // 'accept'
  }
}

/** A JSON-file-backed {@link ToggleStore}; tolerant of a missing/corrupt file. */
function fileToggleStore(statePath: string): ToggleStore {
  return {
    read: () => {
      if (!existsSync(statePath)) return {};
      try {
        return JSON.parse(readFileSync(statePath, 'utf8'));
      } catch {
        return {}; // corrupt file ⇒ treat as empty (default enabled)
      }
    },
    write: (state) => {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    },
  };
}

/** The real core operations, bound for injection into the tools. */
const CORE: CorePort = { filterEventsSince, summarize, tokenStats, routeDecide, eligibleLanes, evaluate, taskCategories: TASK_CATEGORIES };

/** Build the injected deps from the environment (lazy loaders per call). */
export function makeServerDeps(env: NodeJS.ProcessEnv = process.env): ToolDeps {
  const lanesPath = env.TOKENMAXED_LANES ?? DEFAULT_LANES;
  const lanesPathExplicit = env.TOKENMAXED_LANES !== undefined;
  const ledgerPath = env.TOKENMAXED_LEDGER; // undefined ⇒ JsonlLedger default (~/.tokenmaxed)
  const statePath = env.TOKENMAXED_STATE ?? homeFile('state.json');
  const projectKey = env.TOKENMAXED_PROJECT ?? 'default';
  const pricesPath = env.TOKENMAXED_PRICES ?? DEFAULT_PRICES;
  // Gate CLOSED by default: trusted CLI/local/native lanes (the common, safe
  // offloads) always work, but UNTRUSTED worker (BYOK API) lanes stay off until
  // explicitly enabled with TOKENMAXED_GATE_READY=true. Opening the gate is an
  // opt-in that /tokenmaxed:setup (A-8) will perform after verifying a secret
  // scanner is available — so router_preview and router_delegate agree, and
  // neither advertises a worker lane the minimizer would then block.
  const gateReady = env.TOKENMAXED_GATE_READY === 'true';
  // Global kill-switch. Also set in spawned CLI children below, so a cheaper-Claude
  // lane (`claude -p`) can't re-enter routing and recurse (A-5b).
  const globallyDisabled = env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true';
  // C-13 quality escalation — OPT-IN, off by default (adds manager-review + re-run
  // cost). Never active under the global kill-switch. See escToOutcome / E-5.
  const escalateEnabled = env.TOKENMAXED_ESCALATE === 'true' && !globallyDisabled;
  // F-1 learned capability — OPT-IN, off by default. When on, observed manager-
  // review outcomes adjust the EFFECTIVE capability routing scores by. Never active
  // under the kill-switch. Off ⇒ overlay is undefined ⇒ declared scores, unchanged.
  const learnEnabled = env.TOKENMAXED_LEARN_CAPABILITY === 'true' && !globallyDisabled;
  // F-2 reader egress — OPT-IN, off by default. The GLOBAL half of the reader
  // gate; a lane is selectable only if this is on AND it has repo_read_attestation
  // AND an API reader executor AND the safety gate is ready. Never under the
  // kill-switch. This is what authorizes sending repo-read code to a reader vendor.
  const readerEgress = env.TOKENMAXED_READER_EGRESS === 'true' && !globallyDisabled;
  // Shared overlay builder so router_delegate and router_preview apply the SAME
  // learned adjustment (no /why-vs-run divergence). Built from the ledger + clock
  // the adapter owns; undefined when learning is off. Lazy per call (cheap: local
  // JSONL, opt-in).
  const buildObserved = (): ObservedCapabilityByLane | undefined => {
    if (!learnEnabled) return undefined;
    // Fail OPEN: a malformed/unreadable ledger must never block routing (mirrors
    // the best-effort recording path). On any read/parse error, fall back to
    // declared capability by returning undefined.
    try {
      return outcomeCapability(new JsonlLedger(ledgerPath).readAll(), Date.now());
    } catch {
      return undefined;
    }
  };
  // A lane is reserved from the initial offload only if it can ACTUALLY serve as
  // the auto-review manager: manager-eligible AND marginal-free (the reviewer
  // restriction in selectReviewManager). A metered manager-eligible lane can't
  // auto-review, so it stays a normal offload candidate (never stranded).
  const reservedForReview = (lane: Lane): boolean =>
    isManagerEligible(lane) && (lane.costBasis === 'subscription' || lane.costBasis === 'local');
  const store = fileToggleStore(statePath);
  // Namespaced BYOK auth (see config.ts): a repo-supplied lanes.yaml can't name an
  // arbitrary secret env var; unknown ⇒ '' ⇒ the executor fails closed.
  const resolveAuth = makeResolveAuth(env);

  // Availability probe: which candidate lanes can actually run now (CLI installed,
  // local server reachable, BYOK key present). Shared by preview and delegate (and
  // host-review/setup via the same helper) so they all agree and never pick an
  // unavailable lane.
  const probeAvailable = makeAvailabilityProbe(env);

  // Fail-closed policy loader (shared with the review path via config.ts): an
  // explicitly configured but missing policy throws; the default path missing
  // (pre-setup) falls back to {} (core deny-by-default + closed gate still apply).
  const loadPolicySafe = makeLoadPolicy(env);

  // The candidate set both preview and delegate route over: the category's
  // candidate lanes minus any unpriceable metered lane (see recordableLane).
  // A MISSING DEFAULT config (pre-setup) is not an error — it means "no lanes yet"
  // (⇒ native), so the plugin works out of the box. But an EXPLICITLY configured
  // path that's missing is a misconfiguration: surface it instead of silently
  // disabling routing (mirrors loadPolicySafe).
  const usableCandidates = (category: TaskCategory): Lane[] => {
    if (!existsSync(lanesPath)) {
      if (lanesPathExplicit) throw new Error(`configured lane file not found: ${lanesPath}`);
      return [];
    }
    const priceTable = loadPriceTable(pricesPath);
    return loadLaneConfig(lanesPath)
      .candidateLanes(category)
      // Resolve `<family>@latest` to a concrete priced id BEFORE the priceability
      // filter, so an aliased lane routes/prices/displays on its concrete model.
      .map((lane) => resolveLaneModel(lane, priceTable))
      // Drop any STILL-unresolved alias (no priced family member) regardless of cost
      // basis, so a literal "@latest" can never reach execution; then priceability.
      .filter((lane) => !parseModelAlias(lane.model).latest && recordableLane(lane, priceTable));
  };

  const delegate = async (request: DelegateRequest): Promise<DelegateOutcome> => {
    // No DEFAULT lane config yet ⇒ nothing to route to; do it on the host and tell
    // the user how to set up, rather than erroring. But an EXPLICIT missing path is
    // a misconfiguration — surface it (mirrors loadPolicySafe / usableCandidates).
    if (!existsSync(lanesPath)) {
      if (lanesPathExplicit) throw new Error(`configured lane file not found: ${lanesPath}`);
      return {
        laneId: 'native',
        status: 'ok',
        native: true,
        reason: `no lanes configured yet — create ${lanesPath} (see the README for a lanes.yaml example)`,
      };
    }
    const registry = loadLaneConfig(lanesPath);
    const policy = loadPolicySafe();
    const priceTable = loadPriceTable(pricesPath);
    const ledger = new JsonlLedger(ledgerPath);
    // Same usable set preview sees: unpriceable metered lanes are already excluded,
    // so runTask never picks one and can't throw on cost after paying for it.
    const lanes = registry
      .candidateLanes(request.category)
      .map((lane) => resolveLaneModel(lane, priceTable)) // <family>@latest ⇒ concrete priced id
      // Drop a still-unresolved alias (any cost basis) so literal "@latest" never runs.
      .filter((lane) => !parseModelAlias(lane.model).latest && recordableLane(lane, priceTable));
    // Display/outcome must show the RESOLVED model (e.g. minimax-m3), not the alias —
    // the resolved lane set wins; fall back to the registry for ids not in it (native).
    const modelOf = (laneId: string): string | undefined =>
      lanes.find((l) => l.id === laneId)?.model ?? registry.byId(laneId)?.model;
    // F-1: apply the learned overlay (undefined when off ⇒ declared scores). The
    // core selectors read ctx.observedCapability; runWithEscalation preserves it
    // through its effective-context spread, so escalation/reassign also benefit.
    const observedCapability = buildObserved();
    // Exclude lanes that can't run now (e.g. Ollama down) so routing never picks an
    // unavailable lane on cost; threads through runTask/runWithEscalation to
    // routeDecide + canReassign. Empty ⇒ no candidate ⇒ runTask degrades to native.
    // Probe ONLY the gate+policy-eligible lanes (same set routeDecide scores), so a
    // disabled/blocked/gated lane is never probed (no wasted or sensitive I/O).
    const baseCtx = {
      lanes,
      gateReady,
      readerEgress,
      policyContext: request.policyContext ?? {},
      ...(observedCapability ? { observedCapability } : {}),
    };
    const eligible = eligibleLanes({ category: request.category }, baseCtx, policy).map((e) => e.lane);
    const available = await probeAvailable(eligible);
    const ctx = { ...baseCtx, availableLaneIds: available };

    // Execute, THEN record as a separate step: a recording failure (corrupt /
    // unwritable / unappendable ledger) must NEVER discard an already-paid-for
    // result. runTask itself does the gate/minimize/execute; we append after and
    // swallow ledger errors, returning the result with a recordingFailed flag.
    //
    // CLI children run with TOKENMAXED_DISABLE=1 so a cheaper-Claude lane
    // (`claude -p --model <haiku>`) can't load this plugin and recurse (A-5b).
    const runDeps: RunDeps = {
      executeTrusted: makeTrustedExecutor({
        cli: makeCliExecutor(makeCliSpawn()),
        api: makeTrustedApiExecutor({ resolveAuth }),
      }),
      executeUntrusted: (envelope) => executeUntrusted(envelope, { resolveAuth }),
      untrustedLaneDTO: laneToUntrustedDTO,
      executeReader: (envelope) => executeReader(envelope, { resolveAuth }),
      readerLaneDTO: laneToReaderDTO,
      scanSecrets: makeGitleaksScanner(),
      priceTable,
      newId: () => randomUUID(),
    };
    const taskInput = {
      category: request.category,
      instruction: request.instruction,
      ...(request.policyContext ? { policyContext: request.policyContext } : {}),
    };

    // C-13 (opt-in): offload → review → escalate/rework/give_back. The manager
    // runs via the same trusted executor (core restricts managers to marginal-free
    // lanes). Persist BOTH task + outcome events; a recording failure never
    // discards an already-produced result. Latency per leg is bounded by the CLI
    // spawn timeout; local/api legs are best-effort (abortable timeouts deferred).
    if (escalateEnabled) {
      const escDeps: EscalationDeps = {
        ...runDeps,
        runManager: (lane, prompt) => runDeps.executeTrusted(lane, prompt).then((res) => res.resultText),
      };
      // Reserve only lanes that can actually auto-review (manager-eligible AND
      // marginal-free) from the FIRST offload, so a stronger reviewer doesn't win
      // the initial pass leaving nothing to escalate to. A metered manager stays an
      // offload candidate. The full set is still the escalation + manager pool. If
      // every candidate is reserved, routing degrades to native — a safe give-back.
      const offloadLanes = lanes.filter((lane) => !reservedForReview(lane));
      const esc = await runWithEscalation(taskInput, { ...ctx, lanes: offloadLanes }, policy, escDeps, { candidates: lanes });
      let escRecordingFailed = false;
      try {
        for (const ev of esc.events) {
          if (ev.kind === 'task') ledger.appendTask(ev.event);
          else ledger.appendOutcome(ev.event);
        }
      } catch {
        escRecordingFailed = true;
      }
      return escToOutcome(esc, modelOf, escRecordingFailed);
    }

    const result = await runTask(taskInput, ctx, policy, runDeps);
    let recordingFailed = false;
    try {
      for (const event of result.events) ledger.appendTask(event);
    } catch {
      recordingFailed = true; // keep the result; recording is best-effort
    }
    const resultModel = modelOf(result.laneId);
    return {
      laneId: result.laneId,
      status: result.status,
      ...(result.native ? { native: true } : {}),
      ...(result.resultText !== undefined ? { resultText: result.resultText } : {}),
      ...(resultModel ? { model: resultModel } : {}),
      ...(result.failureKind ? { failureKind: result.failureKind } : {}),
      ...(result.decision?.reason ? { reason: result.decision.reason } : {}),
      ...(result.readerDerived ? { readerDerived: true } : {}),
      ...(recordingFailed ? { recordingFailed: true } : {}),
    };
  };

  return {
    readLedger: () => new JsonlLedger(ledgerPath).readAll(),
    // The documented route input (capability-0 opt-outs excluded) minus
    // unpriceable metered lanes. When escalation is on, ALSO reserve manager-
    // eligible lanes (as delegate does), so /tokenmaxed:why mirrors the initial
    // offload routing exactly. Lazy per call.
    candidateLanes: (category) => {
      const c = usableCandidates(category);
      return escalateEnabled ? c.filter((lane) => !reservedForReview(lane)) : c;
    },
    // Same availability probe delegate routes with, so /tokenmaxed:why never
    // advertises a lane that can't run (e.g. a free local lane whose server is down).
    availableLaneIds: probeAvailable,
    // F-1: same learned overlay delegate routes with (undefined ⇒ declared), so
    // /tokenmaxed:why reflects the effective capability, not the stale prior.
    observedCapability: buildObserved,
    loadPolicy: loadPolicySafe,
    // Expose the server's effective gate posture so router_preview defaults to the
    // SAME gate state router_delegate routes with — keeping /tokenmaxed:why honest.
    gateReady,
    // F-2: same reader-egress posture delegate routes with (so /why shows reader
    // lanes only when they'd actually be selectable).
    readerEgress,
    // TOKENMAXED_DISABLE forces routing off (kill-switch + recursion guard),
    // overriding the per-project toggle.
    getEnabled: () => (globallyDisabled ? false : readEnabled(store, projectKey)),
    setEnabled: (enabled) => writeEnabled(store, projectKey, enabled),
    // Session summary (router_summary / /tokenmaxed:summary), composed from the same
    // local sources the SessionStart hook uses via the shared makeSummaryFromEnv —
    // one source of truth. Read-only.
    summary: makeSummaryFromEnv(env),
    // MODEL-FRESHNESS: check enabled API lanes for a stale pinned model (router_status).
    // Gated egress — only non-blocked, gate-open, keyed api lanes get a /models call
    // (key only, no content); never when routing is globally disabled. Caches results.
    freshness: async () => {
      if (globallyDisabled || !gateReady || !existsSync(lanesPath)) return [];
      const registry = loadLaneConfig(lanesPath);
      // Keyed lanes only — never send an UNauthenticated /models request.
      const eligible = registry.lanes.filter(
        (l) => l.kind === 'api' && l.trust_mode !== 'blocked' && !!l.authHandle && resolveAuth(l.authHandle).length > 0,
      );
      const cachePath = env.TOKENMAXED_MODEL_CACHE ?? join(dirname(statePath), 'model-freshness.json');
      return reportFreshness(
        eligible,
        {
          fetchList: (lane) => fetchModelList(lane, { resolveAuth }),
          table: loadPriceTable(pricesPath),
          now: Date.now(),
          readCache: () => readFreshnessCache(cachePath),
          writeCache: (c) => writeFreshnessCache(cachePath, c),
        },
        { refresh: true },
      );
    },
    delegate,
    // Manual manager review of the turn's diff (A-7); the Stop gate reuses the same
    // path independently. Honor the global kill-switch so a recursion-guarded child
    // (TOKENMAXED_DISABLE=1) can't review + spawn again. runReviewWithBudget bounds
    // the call (total deadline + retry) so a hung manager never stalls the turn.
    review: (): Promise<ReviewOutcome> =>
      globallyDisabled
        ? Promise.resolve({ reviewed: false, reason: 'routing is disabled (TOKENMAXED_DISABLE)' })
        : runReviewWithBudget(makeReviewRunner(makeHostReviewDeps(env)), randomUUID),
    // Create/validate user config + report status (A-8).
    setup: () => runSetup(env),
    now: () => Date.now(),
  };
}

/** Advertised tool list for ListTools (name/description/inputSchema only). */
function advertisedTools(tools: readonly ToolDef[]) {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/** Create the MCP Server with handlers wired to {@link ToolDeps}. */
export function createServer(deps: ToolDeps): Server {
  const tools = createTools(CORE);
  const server = new Server(
    { name: 'tokenmaxed', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: advertisedTools(tools) }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const result = await dispatch(tools, deps, request.params.name, request.params.arguments);
    // ToolResult is structurally a CallToolResult; the SDK's tools/call return is
    // a union (with experimental task results) so we narrow with a cast.
    return result as CallToolResult;
  });

  return server;
}

/** Start the server over stdio. Called by the bin entry. */
export async function startStdioServer(): Promise<void> {
  const server = createServer(makeServerDeps());
  await server.connect(new StdioServerTransport());
}
