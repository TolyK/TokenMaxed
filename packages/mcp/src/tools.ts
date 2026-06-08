/**
 * A-1 — read-only MCP tool definitions over the TokenMaxed core.
 *
 * PURE + NO PACKAGE-NAME RUNTIME IMPORTS: this module imports neither the MCP
 * SDK nor any Node I/O, and it imports `@tokenmaxed/core` for **types only**
 * (`import type`, erased at runtime). The core's pure operations are passed in
 * via {@link CorePort}, mirroring how core itself injects all I/O. This keeps the
 * documented no-build test workflow intact: `node --test` type-strips this file
 * without resolving the built `@tokenmaxed/core` package (see CONTRIBUTING).
 *
 * Read-only surface only (A-1): `router_savings`, `router_tokens`,
 * `router_preview`. Nothing here executes a lane, sends content, or writes.
 */

import type {
  LedgerEvent,
  LedgerSummary,
  Lane,
  ObservedCapabilityByLane,
  Policy,
  PolicyContext,
  PolicyDecision,
  RepoClass,
  RouteContext,
  RouteDecision,
  Sensitivity,
  Task,
  TaskCategory,
  TaskStatus,
  TokenStats,
} from '@tokenmaxed/core';

import { renderModelIdMismatchWarnings, renderStalenessWarnings } from './freshness-report.ts';
import type { ModelIdMismatchWarning, StalenessWarning } from './freshness-report.ts';
import { formatLaneSetup } from './lane-setup.ts';
import type { LaneSetupRow } from './lane-setup.ts';
import { formatSummaryBanner } from './summary.ts';
import type { SummaryData } from './summary.ts';

// --- ports + result + dependency shapes ----------------------------------------

/** The pure core operations the tools call, injected so this stays no-build. */
export interface CorePort {
  filterEventsSince: (events: readonly LedgerEvent[], sinceIso?: string) => LedgerEvent[];
  summarize: (events: readonly LedgerEvent[]) => LedgerSummary;
  tokenStats: (events: readonly LedgerEvent[]) => TokenStats;
  routeDecide: (task: Task, ctx: RouteContext, policy: Policy) => RouteDecision;
  /** The gate+policy-eligible lanes for a task (no availability/scoring) — the set worth probing. */
  eligibleLanes: (task: Task, ctx: RouteContext, policy: Policy) => { lane: Lane }[];
  evaluate: (task: Task, lane: Lane, ctx: PolicyContext, policy: Policy) => PolicyDecision;
  /** Canonical task categories (core's TASK_CATEGORIES). */
  taskCategories: readonly TaskCategory[];
}

/** A single text block in an MCP tool result. */
export interface ToolTextContent {
  type: 'text';
  text: string;
}

/** An MCP CallTool result (subset we emit): human text + machine structuredContent. */
export interface ToolResult {
  content: ToolTextContent[];
  /** Machine-readable payload mirrored to MCP clients that support it. */
  structuredContent?: Record<string, unknown>;
  /** true ⇒ the call failed (bad input, etc.); content carries the message. */
  isError?: boolean;
}

/** Injected I/O — the server fills these from core/node; tests fake them. */
export interface ToolDeps {
  /** All ledger events (content-free), newest-or-any order. */
  readLedger: () => LedgerEvent[];
  /**
   * The candidate lanes for a category — the DOCUMENTED route input
   * (`LaneRegistry.candidateLanes`), which excludes lanes that opted out of the
   * category (capability 0). Routing over the full lane set would let an
   * opted-out lane win, so preview must use this, matching the real run path.
   */
  candidateLanes: (category: TaskCategory) => Lane[];
  /**
   * The learned capability overlay (F-1), or `undefined` when learning is off
   * (TOKENMAXED_LEARN_CAPABILITY) — in which case routing uses declared scores
   * exactly as before. Built server-side from the ledger + clock so router_preview
   * and router_delegate apply the SAME overlay (no divergence between /why and the
   * real run path).
   */
  observedCapability: () => ObservedCapabilityByLane | undefined;
  /** The active routing policy (from policy.yaml via core/node). */
  loadPolicy: () => Policy;
  /**
   * The server's effective safety-gate posture. router_preview defaults to this
   * (so /tokenmaxed:why matches what router_delegate would actually do); the
   * caller can still override per-call with `gate_ready`.
   */
  gateReady: boolean;
  /**
   * F-2: whether the global reader-egress opt-in (`TOKENMAXED_READER_EGRESS`) is on,
   * so router_preview reflects the same reader selectability router_delegate routes
   * with. Default surface is off ⇒ reader lanes never appear.
   */
  readerEgress: boolean;
  /**
   * MODEL-TIERS: routing strategy router_delegate uses, so router_preview shows the
   * same pick. `tiered` ⇒ cheapest lane clearing the floor; default `maximize`.
   */
  tieredStrategy?: 'maximize' | 'tiered';
  /** Tiered capability floor (undefined ⇒ core default). */
  tierFloor?: number;
  /** Per-lane cost signal (price-derived) for tiered ranking; optional. */
  laneCost?: (lanes: readonly Lane[]) => Record<string, number>;
  /** Whether routing/offloading is enabled for the current project (A-4 toggle). */
  getEnabled: () => boolean;
  /**
   * Check enabled API lanes for a stale pinned model (MODEL-FRESHNESS). Makes a
   * gated provider /models call + updates the freshness cache; returns one warning
   * per stale lane. Optional so non-networked callers/tests can omit it.
   */
  freshness?: () => Promise<StalenessWarning[]>;
  /**
   * UNIVERSAL guard: after a freshness refresh, check whether each api lane's resolved
   * model id is actually accepted (exact casing) by the vendor's live /models list, so
   * a wrong/miscased id can never silently ship for any provider. CACHE-ONLY; call
   * after `freshness()` on the same path. Optional so non-networked callers/tests omit it.
   */
  idMismatch?: () => Promise<ModelIdMismatchWarning[]>;
  /** Persist the project's enabled state (A-4 toggle). */
  setEnabled: (enabled: boolean) => void;
  /**
   * The per-project PREFERRED lane id (universal offload override), or undefined when
   * unset. router_preview and router_delegate route with this as `preferLaneId` so the
   * router favors that lane when it is eligible/available/capable. Absent ⇒ normal
   * capability-ranked routing.
   */
  preferredLane?: () => string | undefined;
  /** Set (lane id) or clear (undefined) the per-project preferred lane. Powers /tokenmaxed:prefer. */
  setPreferredLane?: (laneId: string | undefined) => void;
  /**
   * Run one bounded subtask through the core path (gate → minimize-if-worker →
   * execute → record) and return its outcome (A-5). Injected so tools.ts stays
   * free of core/node runtime imports; the server wires it to `runAndRecord`.
   */
  delegate: (request: DelegateRequest) => Promise<DelegateOutcome>;
  /**
   * Ids of the candidate lanes that can actually RUN now (provider CLI installed,
   * local server reachable, BYOK key present). Injected so the pure tools layer
   * stays free of host I/O. When present, router_preview routes with the same
   * availability filter router_delegate uses, so /tokenmaxed:why never advertises
   * a lane that isn't runnable. Absent ⇒ availability is not checked.
   */
  availableLaneIds?: (lanes: readonly Lane[]) => Promise<string[]>;
  /**
   * Build the session summary (windows + lane/role/availability + savings) for
   * router_summary / the /tokenmaxed:summary skill. The server wires the real
   * ledger + registry + availability + core fns + selectManagerLane behind this,
   * keeping tools.ts free of host I/O and runtime core imports.
   */
  summary: () => Promise<SummaryData>;
  /** Have the configured manager review the turn's working-tree diff (A-7). */
  review: () => Promise<ReviewOutcome>;
  /** Create/validate user config and report setup status (A-8). */
  setup: () => Promise<SetupReport>;
  /** Current wall-clock in ms (injected so tests are deterministic). */
  now: () => number;
}

/** Status returned by the setup flow (A-8). */
export interface SetupReport {
  lanesPath: string;
  policyPath: string;
  lanesCreated: boolean;
  policyCreated: boolean;
  laneCount: number;
  managerLaneId?: string;
  gitleaksAvailable: boolean;
  gateReady: boolean;
  /** REVIEW-LOOP: whether the default-on review-iterate loop runs (on unless opted out). */
  reviewOnStop: boolean;
  /** REVIEW-LOOP: rework rounds the loop drives before yielding (Protection B bound). */
  reviewMaxRounds?: number;
  /** C-13: whether quality escalation is enabled (TOKENMAXED_ESCALATE). */
  escalate: boolean;
  /** F-1: whether learned capability feedback is enabled (TOKENMAXED_LEARN_CAPABILITY). */
  learnCapability: boolean;
  /** F-2: whether reader-egress is enabled (TOKENMAXED_READER_EGRESS). */
  readerEgress: boolean;
  /** MODEL-TIERS: whether tiered routing is enabled (TOKENMAXED_TIERED). */
  tiered: boolean;
  /** SETUP-1: per-lane confirmation rows (model/trust/permissions/role/availability). */
  lanes: LaneSetupRow[];
  /**
   * SETUP-1 B: lane-review state for this project vs the configured lane set —
   * 'first-review' (never reviewed here), 'changed' (config changed since last review),
   * or 'current'. Setup marks the set as reviewed when it runs.
   */
  laneReview: 'first-review' | 'changed' | 'current';
}

/** Outcome of a manager review (content-free; the diff is never returned/stored). */
export interface ReviewOutcome {
  /** false ⇒ no review ran (no changes, no manager configured, …); see reason. */
  reviewed: boolean;
  verdict?: 'pass' | 'needs-rework' | 'fail';
  notes?: string;
  managerLaneId?: string;
  reason?: string;
}

/** A single offload request handed to {@link ToolDeps.delegate}. */
export interface DelegateRequest {
  category: TaskCategory;
  instruction: string;
  policyContext?: PolicyContext;
  /**
   * OPTIONAL repo-relative file paths to attach VERBATIM so the lane sees real repo
   * facts (the file being edited, a registry, test fixtures) instead of guessing. The
   * server reads them path-confined to the project; the minimizer then scrubs +
   * size-bounds + policy-gates them (private-repo files require a reader-trust lane +
   * its egress opt-in). Files that can't be safely read are dropped + surfaced.
   */
  files?: string[];
}

/** The outcome of an offload (content-free; the host decides what to do with it). */
export interface DelegateOutcome {
  laneId: string;
  status: TaskStatus;
  /** true ⇒ the host should perform the task itself (no other lane ran it). */
  native?: boolean;
  /** The lane's result text, when a lane executed the task. */
  resultText?: string;
  /** The executing lane's model id, for display. */
  model?: string;
  /** Normalized failure category when status is failed/blocked. */
  failureKind?: string;
  /** Routing explanation (e.g. why it degraded to native, or "escalated to X"). */
  reason?: string;
  /** true ⇒ the lane ran but its event could not be written to the ledger. */
  recordingFailed?: boolean;
  /** C-13: the offload ran but the manager review couldn't (result is UNREVIEWED). */
  reviewUnavailable?: boolean;
  /**
   * F-2 taint: true ⇒ a `reader` lane produced this text, which may echo private
   * repo code. Surfaced to the caller so it is not re-delegated to a worker or
   * pasted into untrusted contexts.
   */
  readerDerived?: boolean;
}

/** A declarative tool: advertised by the server, invoked via its handler. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema (object) advertised to the MCP client for input validation. */
  inputSchema: Record<string, unknown>;
  handler: (deps: ToolDeps, args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;
}

/** Bad tool input (period string, unknown category, …). Caught → isError result. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

// --- small pure helpers (no core dependency) -----------------------------------

const PERIOD_RE = /^(\d+)([dh])$/;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Resolve a `period` ("all" / undefined ⇒ no filter, or "7d" / "24h") to an ISO
 * lower bound for `filterEventsSince`. Mirrors the CLI's resolvePeriodSince;
 * kept local so this package has no app dependency (see tracking: consolidate).
 */
function resolveSinceIso(period: string | undefined, nowMs: number): string | undefined {
  if (period === undefined || period === 'all') return undefined;
  const m = PERIOD_RE.exec(period);
  if (!m) {
    throw new ToolInputError(`Invalid period "${period}". Use "all" or N followed by d/h, e.g. "7d".`);
  }
  const ms = (m[2] === 'd' ? DAY_MS : HOUR_MS) * Number(m[1]);
  return new Date(nowMs - ms).toISOString();
}

/** Read an optional string arg; reject non-string so callers fail loudly. */
function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolInputError(`"${key}" must be a string.`);
  return v;
}

/** Read an optional string[] arg; reject non-arrays / non-string elements (schema enforcement). */
function optStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) {
    throw new ToolInputError(`"${key}" must be an array of strings.`);
  }
  return v as string[];
}

/** Read an optional boolean arg; reject other types so the schema is enforced. */
function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ToolInputError(`"${key}" must be a boolean.`);
  return v;
}

function optEnum<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const v = optString(args, key);
  if (v === undefined) return undefined;
  if (!allowed.includes(v as T)) {
    throw new ToolInputError(`"${key}" must be one of: ${allowed.join(', ')}.`);
  }
  return v as T;
}

function ok(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function failResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run a handler body, mapping {@link ToolInputError} to an isError result. */
function guarded(body: () => ToolResult): ToolResult {
  try {
    return body();
  } catch (err) {
    if (err instanceof ToolInputError) return failResult(err.message);
    throw err;
  }
}

/** Async variant of {@link guarded} for handlers that await injected I/O. */
async function guardedAsync(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof ToolInputError) return failResult(err.message);
    throw err;
  }
}

/** Format a percentage that is ALREADY in percent units (e.g. 80 ⇒ "80.0%"). */
function pct(alreadyPercent: number): string {
  return `${alreadyPercent.toFixed(1)}%`;
}

const REPO_CLASSES: readonly RepoClass[] = ['public', 'private', 'unknown'];
const SENSITIVITIES: readonly Sensitivity[] = ['normal', 'sensitive', 'unknown'];

// --- render helpers ------------------------------------------------------------

function renderSavings(summary: LedgerSummary, tokens: TokenStats, period: string | undefined): string {
  const s = summary.savings;
  const scope = period && period !== 'all' ? ` (last ${period})` : '';
  if (summary.events === 0) return `No tasks recorded yet${scope}. Run some routed work to populate savings.`;
  // HEADLINE = honest finance-grade numbers (actual spend + metered avoided);
  // the all-frontier baseline is a hypothetical ceiling, demoted + labeled.
  // *_pct are already in percent units (aggregateSavings multiplies by 100).
  const lines = [
    `Savings${scope} — ${summary.events} event(s)`,
    `  actual API spend:            $${summary.metered_spent_total.toFixed(4)}`,
    `  metered spend avoided:       $${s.metered_avoided.toFixed(4)} (${pct(s.metered_avoided_pct)}) — finance-grade`,
    `  — baseline context (hypothetical: every task on the frontier model) —`,
    `  vs all-frontier baseline:    $${s.frontier_avoided.toFixed(4)} (${pct(s.frontier_avoided_pct)})`,
    `  tokens: ${tokens.total.in} in / ${tokens.total.out} out`,
  ];
  if (summary.blockCount > 0) lines.push(`  blocked tasks: ${summary.blockCount}`);
  return lines.join('\n');
}

function renderTokens(tokens: TokenStats, by: 'model' | 'lane', period: string | undefined): string {
  const scope = period && period !== 'all' ? ` (last ${period})` : '';
  const groups = by === 'lane' ? tokens.byLane : tokens.byModel;
  const keys = Object.keys(groups).sort();
  const head = `Tokens${scope} — ${tokens.total.in} in / ${tokens.total.out} out (total ${tokens.total.total})`;
  if (keys.length === 0) return `${head}\n  (no per-${by} breakdown yet)`;
  const rows = keys.map((k) => {
    const g = groups[k]!;
    return `  ${k}: ${g.in} in / ${g.out} out (${g.events} event(s))`;
  });
  return [head, `by ${by}:`, ...rows].join('\n');
}

// --- tool factory --------------------------------------------------------------

/**
 * Build the read-only tool defs bound to the injected {@link CorePort}. A factory
 * (not a module constant) so the core operations are injected, keeping this file
 * free of package-name runtime imports.
 */
export function createTools(core: CorePort): ToolDef[] {
  function eventsInPeriod(deps: ToolDeps, period: string | undefined): LedgerEvent[] {
    const since = resolveSinceIso(period, deps.now());
    return core.filterEventsSince(deps.readLedger(), since);
  }

  const savingsTool: ToolDef = {
    name: 'router_savings',
    description:
      'Report TokenMaxed savings from the local content-free ledger: frontier-equivalent and metered spend avoided, actual spend, and token totals. Read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period: { type: 'string', description: 'Window: "all" (default) or N + d/h, e.g. "7d" or "24h".' },
      },
    },
    handler: (deps, args) =>
      guarded(() => {
        const period = optString(args, 'period');
        const events = eventsInPeriod(deps, period);
        const summary = core.summarize(events);
        const tokens = core.tokenStats(events);
        return ok(renderSavings(summary, tokens, period), { summary, tokens });
      }),
  };

  const tokensTool: ToolDef = {
    name: 'router_tokens',
    description: 'Report token usage from the local ledger, broken down by model (default) or lane. Read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period: { type: 'string', description: 'Window: "all" (default) or N + d/h, e.g. "7d".' },
        by: { type: 'string', enum: ['model', 'lane'], description: 'Group by "model" (default) or "lane".' },
      },
    },
    handler: (deps, args) =>
      guarded(() => {
        const period = optString(args, 'period');
        const by = optEnum(args, 'by', ['model', 'lane'] as const) ?? 'model';
        const tokens = core.tokenStats(eventsInPeriod(deps, period));
        return ok(renderTokens(tokens, by, period), { tokens, by });
      }),
  };

  const summaryTool: ToolDef = {
    name: 'router_summary',
    description:
      'Session summary from the local content-free ledger: token usage + metered $ avoided over 24h/7d/lifetime, the configured lanes with their trust/role and live availability, and the active reviewer. Powers /tokenmaxed:summary and the session-start banner. Read-only; nothing is sent anywhere.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: (deps) =>
      guardedAsync(async () => {
        const data = await deps.summary();
        return ok(formatSummaryBanner(data), { summary: data as unknown as Record<string, unknown> });
      }),
  };

  const previewTool: ToolDef = {
    name: 'router_preview',
    description:
      'Preview which lane would handle a task category under the current lanes + policy, without executing anything. Powers /router:why. Read-only; no content is sent anywhere.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['category'],
      properties: {
        category: { type: 'string', enum: [...core.taskCategories], description: 'Task category to route.' },
        repo_class: { type: 'string', enum: [...REPO_CLASSES], description: 'Repository class for policy (default unknown).' },
        sensitivity: { type: 'string', enum: [...SENSITIVITIES], description: 'Content sensitivity for policy (default unknown).' },
        gate_ready: {
          type: 'boolean',
          description:
            'Whether the minimization/policy gate is ready. Defaults to the server\'s current gate posture (the same state router_delegate routes with). Override to preview a different gate state.',
        },
      },
    },
    handler: (deps, args) =>
      guardedAsync(async () => {
        const category = optEnum(args, 'category', core.taskCategories);
        if (category === undefined) throw new ToolInputError('"category" is required.');
        const repo_class = optEnum(args, 'repo_class', REPO_CLASSES);
        const sensitivity = optEnum(args, 'sensitivity', SENSITIVITIES);

        // When routing is off for the project, router_delegate degrades to native;
        // the preview must say the same so /tokenmaxed:why never advertises a lane
        // delegation would not use.
        if (!deps.getEnabled()) {
          return ok(
            `category "${category}": TokenMaxed routing is DISABLED for this project — it would run on the host (native). Run /tokenmaxed:on to re-enable.`,
            { category, disabled: true, native: true, decision: null },
          );
        }

        // Default to the server's gate posture so a preview never disagrees with
        // what router_delegate would actually do; an explicit arg overrides.
        const gateReady = optBool(args, 'gate_ready') ?? deps.gateReady;

        const policyContext: PolicyContext = {
          ...(repo_class ? { repo_class } : {}),
          ...(sensitivity ? { sensitivity } : {}),
        };
        // Route over the category's candidate lanes (capability-0 opt-outs excluded),
        // matching the documented run path — never the full lane set.
        const lanes = deps.candidateLanes(category);
        const policy = deps.loadPolicy();
        // Apply the learned overlay (F-1) so /tokenmaxed:why reflects the same
        // effective capability router_delegate routes with. Undefined ⇒ declared.
        const observedCapability = deps.observedCapability();
        // Same availability filter delegate routes with (when the host provides it),
        // so /tokenmaxed:why never advertises a lane that can't actually run. Probe
        // ONLY the gate+policy-eligible lanes — never a disabled/blocked/gated lane
        // (no wasted I/O, and no network probe to a lane policy would reject).
        let availableIds: string[] | undefined;
        if (deps.availableLaneIds) {
          const baseCtx: RouteContext = {
            lanes,
            gateReady,
            readerEgress: deps.readerEgress,
            policyContext,
            ...(observedCapability ? { observedCapability } : {}),
          };
          const eligible = core.eligibleLanes({ category }, baseCtx, policy).map((e) => e.lane);
          availableIds = await deps.availableLaneIds(eligible);
        }
        // MODEL-TIERS: mirror delegate's tiered posture + cost signal so /why agrees.
        const tieredCtx =
          deps.tieredStrategy === 'tiered'
            ? {
                strategy: 'tiered' as const,
                ...(deps.tierFloor !== undefined ? { tierFloor: deps.tierFloor } : {}),
                ...(deps.laneCost ? { laneCost: deps.laneCost(lanes) } : {}),
              }
            : {};
        // The per-project preferred lane (universal offload override): mirror it into the
        // preview ctx so /tokenmaxed:why shows the SAME pick router_delegate would make.
        const preferLaneId = deps.preferredLane?.();
        const ctx: RouteContext = {
          lanes,
          gateReady,
          readerEgress: deps.readerEgress,
          policyContext,
          ...(observedCapability ? { observedCapability } : {}),
          ...(availableIds ? { availableLaneIds: availableIds } : {}),
          ...tieredCtx,
          ...(preferLaneId ? { preferLaneId } : {}),
        };

        let decision: RouteDecision;
        try {
          decision = core.routeDecide({ category }, ctx, policy);
        } catch {
          // No selectable lane (all gated/blocked/unavailable) ⇒ the host does it.
          return ok(
            `category "${category}": no eligible lane (gate_ready=${gateReady}) — would run on the host (native).`,
            { category, gateReady, policyContext, decision: null, native: true },
          );
        }

        const lane = lanes.find((l) => l.id === decision.laneId);
        // Surface the policy verdict explicitly so /router:why can explain a forced lane.
        const verdict = lane ? core.evaluate({ category }, lane, policyContext, policy).verdict : decision.policyVerdict;
        // When a preferred lane is set but did NOT win, say why it fell back — so the
        // user isn't surprised the "use lane X for now" override didn't apply here.
        const preferNote =
          preferLaneId && decision.laneId !== preferLaneId
            ? `  note: preferred lane "${preferLaneId}" was not used — it isn't eligible, available, or capable for this category (fell back to normal routing).`
            : undefined;
        const text = [
          `category "${category}" → lane "${decision.laneId}"`,
          lane ? `  ${lane.kind} · ${lane.model} · trust=${lane.trust_mode}` : '  (lane not found in config)',
          `  policy verdict: ${verdict}`,
          `  why: ${decision.reason}`,
          ...(preferNote ? [preferNote] : []),
        ].join('\n');
        return ok(text, { category, gateReady, policyContext, decision, verdict, native: false, ...(preferLaneId ? { preferLaneId } : {}) });
      }),
  };

  const statusTool: ToolDef = {
    name: 'router_status',
    description:
      'Report whether TokenMaxed routing is enabled for this project, and check each enabled API lane for a stale pinned model. This makes a provider /models call (sends only the API key — no repo/task content) and updates the local freshness cache. Routing is never changed.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: (deps) =>
      guardedAsync(async () => {
        const enabled = deps.getEnabled();
        const warnings = enabled && deps.freshness ? await deps.freshness() : [];
        // UNIVERSAL id guard: after the freshness refresh populated the cache, flag any
        // lane whose resolved model id the vendor would reject (wrong casing / absent).
        const mismatches = enabled && deps.idMismatch ? await deps.idMismatch() : [];
        const preferred = deps.preferredLane?.();
        const lines = [`TokenMaxed routing is ${enabled ? 'ENABLED' : 'DISABLED'} for this project.`];
        if (preferred) {
          lines.push(`Preferred lane: "${preferred}" (favored when eligible/available/capable; /tokenmaxed:prefer off to clear).`);
        }
        if (mismatches.length > 0) {
          lines.push('', 'Model ids the vendor will REJECT (fix before offloading):', ...renderModelIdMismatchWarnings(mismatches));
        }
        if (warnings.length > 0) {
          lines.push('', 'Stale pinned models (you can keep them, or move to the latest):', ...renderStalenessWarnings(warnings));
        } else if (enabled && deps.freshness) {
          // Honest: empty ⇒ nothing FLAGGED, which also covers lanes we couldn't check
          // (no key, unreachable provider, unknown family) — not a positive freshness claim.
          lines.push('No stale models flagged (only enabled, keyed API lanes with a known family are checked).');
        }
        return ok(lines.join('\n'), {
          enabled,
          ...(preferred ? { preferLaneId: preferred } : {}),
          staleness: warnings as unknown as Record<string, unknown>[],
          idMismatch: mismatches as unknown as Record<string, unknown>[],
        });
      }),
  };

  const setEnabledTool: ToolDef = {
    name: 'router_set_enabled',
    description:
      'Enable or disable TokenMaxed routing/offloading for this project. The setting is persisted (project-keyed) and survives restarts. Powers /tokenmaxed:off and :on.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled'],
      properties: { enabled: { type: 'boolean', description: 'true to enable routing, false to disable.' } },
    },
    handler: (deps, args) =>
      guarded(() => {
        const enabled = optBool(args, 'enabled');
        if (enabled === undefined) throw new ToolInputError('"enabled" is required (boolean).');
        deps.setEnabled(enabled);
        return ok(
          `TokenMaxed routing ${enabled ? 'ENABLED' : 'DISABLED'} for this project.`,
          { enabled },
        );
      }),
  };

  const setPreferTool: ToolDef = {
    name: 'router_set_prefer',
    description:
      "Set or clear a per-project PREFERRED lane for TokenMaxed routing. When set, the router favors that lane over the normal capability ranking whenever it is eligible, available, and capable for the task. Use this to temporarily push work to a specific lane (e.g. when one subscription's credits are running low) — works with ANY configured lane (any vendor, CLI or API). Clearing the preference restores normal capability-ranked routing. The setting is persisted per project and survives restarts; no relaunch is needed. Powers /tokenmaxed:prefer.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lane: {
          type: 'string',
          description:
            'The lane id to prefer (any configured lane — any vendor, CLI or API). Omit or pass an empty string to CLEAR the preference (restore normal routing).',
        },
      },
    },
    handler: (deps, args) =>
      guarded(() => {
        const raw = optString(args, 'lane');
        const lane = typeof raw === 'string' ? raw.trim() : undefined;
        if (!lane) {
          deps.setPreferredLane?.(undefined);
          return ok('Lane preference CLEARED — TokenMaxed will route normally for this project.', { preferLaneId: null });
        }
        deps.setPreferredLane?.(lane);
        return ok(
          `Preferred lane set to "${lane}" for this project — routing will favor it when it is eligible, available, and capable for the task (else it falls back to normal routing). Run /tokenmaxed:prefer off to clear.`,
          { preferLaneId: lane },
        );
      }),
  };

  const delegateTool: ToolDef = {
    name: 'router_delegate',
    description:
      'Offload ONE bounded, self-contained coding subtask to the cheapest capable, policy-allowed lane. Returns either the lane\'s result (use it) OR a directive to handle the task yourself (native). Untrusted lanes receive only a minimized, scrubbed task — never the repo, secrets, or tools. Records a content-free ledger event. Use for well-specified work (boilerplate, codegen, docs, isolated bugfixes); keep everything the lane needs IN the instruction.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['category', 'instruction'],
      properties: {
        category: { type: 'string', enum: [...core.taskCategories], description: 'Task category (drives lane choice).' },
        instruction: {
          type: 'string',
          description:
            'The self-contained subtask to perform. Include all needed context IN this text. A lane receives nothing else BEYOND any files you pass in `files` — no repo, no tools.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'OPTIONAL repo-relative file paths to attach VERBATIM so the lane sees real repo facts (e.g. the file being edited, a registry, test fixtures) instead of guessing — kills the "blind to your repo" hallucination class. Read server-side, path-confined to the project, then scrubbed + size-bounded + policy-gated by the minimizer (private-repo files require a reader-trust lane + its egress opt-in). Prefer naming the exact files over pasting paraphrased snippets.',
        },
        repo_class: { type: 'string', enum: [...REPO_CLASSES], description: 'Repository class for policy (default unknown).' },
        sensitivity: { type: 'string', enum: [...SENSITIVITIES], description: 'Content sensitivity for policy (default unknown).' },
      },
    },
    handler: (deps, args) =>
      guardedAsync(async () => {
        const category = optEnum(args, 'category', core.taskCategories);
        if (category === undefined) throw new ToolInputError('"category" is required.');
        const instruction = optString(args, 'instruction');
        if (!instruction || instruction.trim() === '') throw new ToolInputError('"instruction" is required (non-empty).');
        const files = optStringArray(args, 'files');
        const repo_class = optEnum(args, 'repo_class', REPO_CLASSES);
        const sensitivity = optEnum(args, 'sensitivity', SENSITIVITIES);

        // Respect the per-project toggle: when off, never offload — tell the host
        // to do it itself (no config load, no execution).
        if (!deps.getEnabled()) {
          return ok(
            'TokenMaxed routing is DISABLED for this project — handle this task yourself (native). Run /tokenmaxed:on to re-enable.',
            { native: true, disabled: true },
          );
        }

        const policyContext: PolicyContext = {
          ...(repo_class ? { repo_class } : {}),
          ...(sensitivity ? { sensitivity } : {}),
        };
        const outcome = await deps.delegate({
          category,
          instruction,
          ...(Object.keys(policyContext).length ? { policyContext } : {}),
          ...(files && files.length ? { files } : {}),
        });
        return renderDelegate(outcome);
      }),
  };

  const reviewTool: ToolDef = {
    name: 'router_review',
    description:
      'Have the configured trusted manager lane review the current working-tree changes (git diff vs HEAD) and return a verdict (pass | needs-rework | fail) with notes. Records a content-free outcome. The diff is sent only to the trusted manager and is never stored.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: (deps) =>
      guardedAsync(async () => {
        const r = await deps.review();
        if (!r.reviewed) {
          return ok(`No review run: ${r.reason ?? 'unavailable'}.`, { reviewed: false, ...(r.reason ? { reason: r.reason } : {}) });
        }
        const head = `Manager review (${r.managerLaneId ?? 'manager'}): ${r.verdict}`;
        const body = r.notes ? `\n\n${r.notes}` : '';
        return ok(`${head}${body}`, {
          reviewed: true,
          verdict: r.verdict,
          ...(r.managerLaneId ? { managerLaneId: r.managerLaneId } : {}),
        });
      }),
  };

  const setupTool: ToolDef = {
    name: 'router_setup',
    description:
      'Set up TokenMaxed: create the user-owned config (~/.tokenmaxed/lanes.yaml + policy.yaml) from starter templates if missing (never overwrites), validate it, and report status — configured lanes, the manager lane, whether a secret scanner (gitleaks) is installed, and the worker-gate / review-loop state. Powers /tokenmaxed:setup.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: (deps) =>
      guardedAsync(async () => {
        const r = await deps.setup();
        const lines = [
          'TokenMaxed setup:',
          `  lanes:  ${r.lanesPath} (${r.lanesCreated ? 'created from starter' : 'already present'})`,
          `  policy: ${r.policyPath} (${r.policyCreated ? 'created from starter' : 'already present'})`,
          `  ${r.laneCount} lane(s) configured; manager: ${r.managerLaneId ?? 'none (set manager_allowed on a trusted CLI/local lane)'}`,
          `  secret scanner (gitleaks): ${r.gitleaksAvailable ? 'available' : 'NOT installed — untrusted worker lanes stay disabled until it is'}`,
          `  worker gate: ${r.gateReady ? 'open' : 'closed'} (open with TOKENMAXED_GATE_READY=true${r.gitleaksAvailable ? '' : ' — install gitleaks first'})`,
          `  review loop: ${r.reviewOnStop ? `ON (default — reviews every finishing turn when a reviewer exists; up to ${r.reviewMaxRounds ?? 5} rework round(s))` : 'off'} (opt out with TOKENMAXED_REVIEW_ON_STOP=false; tune rounds with TOKENMAXED_REVIEW_MAX_ROUNDS)`,
          `  quality escalation: ${r.escalate ? 'on' : 'off'} (enable with TOKENMAXED_ESCALATE=true — offloads a failed cheap result up to a stronger lane)`,
          `  learned capability: ${r.learnCapability ? 'on' : 'off'} (enable with TOKENMAXED_LEARN_CAPABILITY=true — review outcomes adjust routing over time)`,
          `  reader egress: ${r.readerEgress ? 'on' : 'off'} (enable with TOKENMAXED_READER_EGRESS=true — lets reader lanes receive repo-read code; also needs per-lane repo_read_attestation)`,
          `  tiered routing: ${r.tiered ? 'on' : 'off'} (enable with TOKENMAXED_TIERED=true — start on the cheapest lane clearing the capability floor, step up on review failure)`,
          '',
          ...(r.laneReview === 'changed'
            ? ['⚠ Your lanes changed since you last reviewed them — confirm the summary below.']
            : r.laneReview === 'first-review'
              ? ['ℹ Lane review: confirm what each lane may see/do below (recorded so you\'re reminded if it changes).']
              : []),
          ...formatLaneSetup(r.lanes),
          '',
          `Next: edit ${r.lanesPath} to add/trust your lanes; for a BYOK api lane, set its key in env var TOKENMAXED_KEY_<authHandle>.`,
        ];
        return ok(lines.join('\n'), { ...r });
      }),
  };

  return [savingsTool, tokensTool, summaryTool, previewTool, statusTool, setEnabledTool, setPreferTool, delegateTool, reviewTool, setupTool];
}

/** Render a {@link DelegateOutcome} as an advisory directive to the host. */
function renderDelegate(o: DelegateOutcome): ToolResult {
  // Anything that isn't a clean execution by another lane ⇒ the host does it.
  if (o.native || o.status !== 'ok') {
    const why =
      o.status === 'blocked'
        ? 'blocked by policy/minimization (sensitive content stays on the host)'
        : o.status === 'failed'
          ? `lane failed (${o.failureKind ?? 'error'})`
          : (o.reason ?? 'no cheaper capable lane available');
    // On blocked/failed the `why` is a fixed string, so `o.reason` (which carries
    // any "files not attached" note) would be hidden — append it so a dropped repo
    // file is never silently swallowed on the common minimization-blocked path.
    const reasonNote =
      (o.status === 'blocked' || o.status === 'failed') && o.reason ? ` — ${o.reason}` : '';
    // A failed metered attempt that also couldn't be recorded must be flagged, so
    // the user isn't unaware that spend happened off-ledger.
    const note = o.recordingFailed ? ' (note: this attempt could not be recorded to the ledger)' : '';
    // F-2: a reader give-back can carry manager notes quoting the reader output —
    // keep the taint warning/flag on this native path too.
    const taint = o.readerDerived
      ? '\n\n⚠️ reader-derived: any quoted reader output above may include private repo code — do not re-delegate it to an untrusted/worker lane or paste it into untrusted contexts.'
      : '';
    return ok(`Handle this task yourself (native): ${why}${reasonNote}.${note}${taint}`, {
      native: true,
      status: o.status,
      laneId: o.laneId,
      ...(o.reason ? { reason: o.reason } : {}),
      ...(o.failureKind ? { failureKind: o.failureKind } : {}),
      ...(o.readerDerived ? { readerDerived: true } : {}),
      ...(o.recordingFailed ? { recordingFailed: true } : {}),
    });
  }
  const lane = o.model ? `${o.laneId} (${o.model})` : o.laneId;
  const note = o.recordingFailed ? '\n\n(note: this offload could not be recorded to the ledger.)' : '';
  // F-2: warn when the result came from a reader lane — it may echo private repo
  // code, so it must not be re-delegated to a worker or pasted into untrusted contexts.
  // Applies to BOTH the reviewed and the unreviewed branches below.
  const taint = o.readerDerived
    ? '\n\n⚠️ reader-derived: this text may include private repo code — do not re-delegate it to an untrusted/worker lane or paste it into untrusted contexts.'
    : '';
  const taintFlag = o.readerDerived ? { readerDerived: true } : {};
  // C-13: the offload produced output but the manager review couldn't run — the
  // result is UNREVIEWED, so do NOT tell the host to "use it"; flag it for review.
  if (o.reviewUnavailable) {
    return ok(
      `Offloaded to ${lane} — UNREVIEWED (${o.reason ?? 'manager review unavailable'}). Inspect it yourself before using:\n\n${o.resultText ?? ''}${taint}${note}`,
      { native: false, laneId: o.laneId, model: o.model, status: o.status, reviewUnavailable: true, ...(o.reason ? { reason: o.reason } : {}), ...taintFlag, ...(o.recordingFailed ? { recordingFailed: true } : {}) },
    );
  }
  // C-13: `reason` may carry "escalated to X" / "reworked on X" (accept_after_*).
  const how = o.reason ? ` (${o.reason})` : '';
  return ok(`Offloaded to ${lane}${how}. Use this result:\n\n${o.resultText ?? ''}${taint}${note}`, {
    native: false,
    laneId: o.laneId,
    model: o.model,
    status: o.status,
    ...(o.reason ? { reason: o.reason } : {}),
    ...taintFlag,
    ...(o.recordingFailed ? { recordingFailed: true } : {}),
  });
}

// --- dispatch (pure; testable without the SDK or a build) ----------------------

/**
 * Resolve + run a tool by name over a built tool list, mapping unknown tools and
 * loader/config errors (e.g. a missing lanes.yaml) to a content-free isError
 * result rather than a throw — the MCP session stays alive.
 */
export async function dispatch(
  tools: readonly ToolDef[],
  deps: ToolDeps,
  name: string,
  rawArgs: unknown,
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return failResult(`Unknown tool: ${name}`);
  const args =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
  // Enforce the advertised schema's additionalProperties:false ourselves — the
  // SDK only guarantees `arguments` is a record, so a typo'd key (e.g. "peroid")
  // would otherwise be silently ignored and return a misleading default result.
  const unknown = unknownKeys(tool.inputSchema, args);
  if (unknown) return failResult(unknown);
  try {
    return await tool.handler(deps, args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failResult(message);
  }
}

/** Return an error message if args has keys not allowed by the schema, else null. */
function unknownKeys(inputSchema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  if (inputSchema.additionalProperties !== false) return null;
  const properties = inputSchema.properties;
  const allowed = properties && typeof properties === 'object' ? Object.keys(properties) : [];
  const extras = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extras.length === 0) return null;
  return `Unknown argument(s): ${extras.join(', ')}. Allowed: ${allowed.length ? allowed.join(', ') : '(none)'}.`;
}
