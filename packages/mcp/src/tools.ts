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
  Policy,
  PolicyContext,
  PolicyDecision,
  RepoClass,
  RouteContext,
  RouteDecision,
  Sensitivity,
  Task,
  TaskCategory,
  TokenStats,
} from '@tokenmaxed/core';

// --- ports + result + dependency shapes ----------------------------------------

/** The pure core operations the tools call, injected so this stays no-build. */
export interface CorePort {
  filterEventsSince: (events: readonly LedgerEvent[], sinceIso?: string) => LedgerEvent[];
  summarize: (events: readonly LedgerEvent[]) => LedgerSummary;
  tokenStats: (events: readonly LedgerEvent[]) => TokenStats;
  routeDecide: (task: Task, ctx: RouteContext, policy: Policy) => RouteDecision;
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
  /** The active routing policy (from policy.yaml via core/node). */
  loadPolicy: () => Policy;
  /** Whether routing/offloading is enabled for the current project (A-4 toggle). */
  getEnabled: () => boolean;
  /** Persist the project's enabled state (A-4 toggle). */
  setEnabled: (enabled: boolean) => void;
  /** Current wall-clock in ms (injected so tests are deterministic). */
  now: () => number;
}

/** A declarative tool: advertised by the server, invoked via its handler. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema (object) advertised to the MCP client for input validation. */
  inputSchema: Record<string, unknown>;
  handler: (deps: ToolDeps, args: Record<string, unknown>) => ToolResult;
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
  const lines = [
    `Savings${scope} — ${summary.events} event(s)`,
    // *_pct are already in percent units (aggregateSavings multiplies by 100).
    `  frontier-equivalent avoided: $${s.frontier_avoided.toFixed(4)} (${pct(s.frontier_avoided_pct)})`,
    `  metered spend avoided:       $${s.metered_avoided.toFixed(4)} (${pct(s.metered_avoided_pct)})`,
    `  actual spend (all tasks):    $${summary.actual_cost.toFixed(4)}`,
    `  metered spend (all tasks):   $${summary.metered_spent_total.toFixed(4)}`,
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
            'Whether the minimization/policy gate is ready. Default false — matching the core route, which excludes worker (and API) lanes until an adapter asserts the gate. Set true to preview post-gate routing.',
        },
      },
    },
    handler: (deps, args) =>
      guarded(() => {
        const category = optEnum(args, 'category', core.taskCategories);
        if (category === undefined) throw new ToolInputError('"category" is required.');
        const repo_class = optEnum(args, 'repo_class', REPO_CLASSES);
        const sensitivity = optEnum(args, 'sensitivity', SENSITIVITIES);
        // Default false to mirror core's routeDecide (ctx.gateReady ?? false), so
        // a preview never claims a lane the real route would exclude pre-gate.
        const gateReady = optBool(args, 'gate_ready') ?? false;

        const policyContext: PolicyContext = {
          ...(repo_class ? { repo_class } : {}),
          ...(sensitivity ? { sensitivity } : {}),
        };
        // Route over the category's candidate lanes (capability-0 opt-outs excluded),
        // matching the documented run path — never the full lane set.
        const lanes = deps.candidateLanes(category);
        const policy = deps.loadPolicy();
        const ctx: RouteContext = { lanes, gateReady, policyContext };

        let decision: RouteDecision;
        try {
          decision = core.routeDecide({ category }, ctx, policy);
        } catch {
          // No selectable lane (all gated/blocked) ⇒ the host would do it itself.
          return ok(
            `category "${category}": no eligible lane (gate_ready=${gateReady}) — would run on the host (native).`,
            { category, gateReady, policyContext, decision: null, native: true },
          );
        }

        const lane = lanes.find((l) => l.id === decision.laneId);
        // Surface the policy verdict explicitly so /router:why can explain a forced lane.
        const verdict = lane ? core.evaluate({ category }, lane, policyContext, policy).verdict : decision.policyVerdict;
        const text = [
          `category "${category}" → lane "${decision.laneId}"`,
          lane ? `  ${lane.kind} · ${lane.model} · trust=${lane.trust_mode}` : '  (lane not found in config)',
          `  policy verdict: ${verdict}`,
          `  why: ${decision.reason}`,
        ].join('\n');
        return ok(text, { category, gateReady, policyContext, decision, verdict, native: false });
      }),
  };

  const statusTool: ToolDef = {
    name: 'router_status',
    description:
      'Report whether TokenMaxed routing/offloading is currently enabled for this project. Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: (deps) => {
      const enabled = deps.getEnabled();
      return ok(
        `TokenMaxed routing is ${enabled ? 'ENABLED' : 'DISABLED'} for this project.`,
        { enabled },
      );
    },
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

  return [savingsTool, tokensTool, previewTool, statusTool, setEnabledTool];
}

// --- dispatch (pure; testable without the SDK or a build) ----------------------

/**
 * Resolve + run a tool by name over a built tool list, mapping unknown tools and
 * loader/config errors (e.g. a missing lanes.yaml) to a content-free isError
 * result rather than a throw — the MCP session stays alive.
 */
export function dispatch(tools: readonly ToolDef[], deps: ToolDeps, name: string, rawArgs: unknown): ToolResult {
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
    return tool.handler(deps, args);
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
