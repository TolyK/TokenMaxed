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
  AccessNeed,
  AccessNeedInput,
  CapabilityPriorOverlay,
  DifficultyBucket,
  LedgerEvent,
  LedgerSummary,
  Lane,
  ObservedCapabilityByLane,
  ObservedCapabilityByModel,
  ObservedCapabilityByModelDifficulty,
  Policy,
  PolicyContext,
  PolicyDecision,
  RepoClass,
  ResolvedPrior,
  ResolvedPriorOptions,
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
import type { SettingKey, SettingsReport } from './settings.ts';
import { formatSummaryBanner } from './summary.ts';
import type { SummaryData } from './summary.ts';
import { isValidIso8601 } from './target.ts';

// --- ports + result + dependency shapes ----------------------------------------

/** The pure core operations the tools call, injected so this stays no-build. */
export interface CorePort {
  filterEventsSince: (events: readonly LedgerEvent[], sinceIso?: string) => LedgerEvent[];
  summarize: (events: readonly LedgerEvent[]) => LedgerSummary;
  tokenStats: (events: readonly LedgerEvent[]) => TokenStats;
  routeDecide: (task: Task, ctx: RouteContext, policy: Policy) => RouteDecision;
  /** The gate+policy-eligible lanes for a task (no availability/scoring) — the set worth probing. */
  eligibleLanes: (task: Task, ctx: RouteContext, policy: Policy) => { lane: Lane }[];
  evaluate: (task: Task, lane: Lane, ctx: PolicyContext, policy: Policy, elevated?: boolean) => PolicyDecision;
  /** F: the host-gating predicate (route.ts) — /why uses the SAME predicate to name host-blocked lanes. */
  hostAllowsLane: (lane: Lane, ctx: Pick<RouteContext, 'host'>) => boolean;
  /** Per-request model-pin matcher (route.ts) — REQUIRED: an advertised `model` param that a port silently ignored would break the no-substitution contract. */
  modelMatchesPin: (laneModel: string, pin: string) => boolean;
  /** Helper to check if a reader lane is elevated */
  isReaderElevated?: (lane: Lane, fullAccessLaneIds?: readonly string[]) => boolean;
  /** Canonical task categories (core's TASK_CATEGORIES). */
  taskCategories: readonly TaskCategory[];
  classifyTask: (text: string) => { category: TaskCategory; confidence: number; scores: Partial<Record<TaskCategory, number>> };
  MIN_CLASSIFY_CONFIDENCE: number;
  CLASSIFY_FALLBACK_CATEGORY: TaskCategory;
  /** B: calculate quota state for a lane. */
  laneQuotaState?: (events: readonly LedgerEvent[], lane: Lane, now: number) => any;
  /**
   * P2: resolve a lane×category's rankings prior (provenance + clamping) so
   * router_preview can explain the winner's prior source. Pure; optional so
   * fakes/hosts without the prior surface can omit it.
   */
  resolvedPriorFor?: (lane: Lane, category: TaskCategory, priorOverlay?: CapabilityPriorOverlay, opts?: ResolvedPriorOptions) => ResolvedPrior;
}

/** P2: metadata about the active rankings snapshot, for /why + /status + setup. */
export interface CapabilityPriorMeta {
  /** Rankings source id(s) from the snapshot (`sources` joined). */
  source: string;
  /** Snapshot `generated` date string. */
  generated: string;
  /** Task categories the snapshot maps (keys of `mapping`). */
  categories: string[];
  /** Lane×category pairs with no chart match (declared fallback applies). */
  unrankedCount: number;
}

/**
 * P2: the adapter's capability-prior posture. `off` ⇒ flag not set (routing on
 * declared priors, byte-identical to before); `error` ⇒ flag set but the
 * snapshot failed to load/validate (routing UNAFFECTED — declared priors — with
 * a warning to surface); `on` ⇒ overlay active (stale ⇒ zero-upward rule).
 */
export type CapabilityPriorState =
  | { state: 'off' }
  | { state: 'error'; warning: string }
  | { state: 'on'; overlay: CapabilityPriorOverlay; stale: boolean; meta: CapabilityPriorMeta };

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
  candidateLanes: (category: TaskCategory, opts?: { includeReserved?: boolean }) => Lane[];
  /**
   * The learned capability overlay (F-1), or `undefined` when learning is off
   * (TOKENMAXED_LEARN_CAPABILITY) — in which case routing uses declared scores
   * exactly as before. Built server-side from the ledger + clock so router_preview
   * and router_delegate apply the SAME overlay (no divergence between /why and the
   * real run path).
   */
  observedCapability: () => ObservedCapabilityByLane | undefined;
  /**
   * Model-keyed learned capability overlay (P6 F-1), or `undefined` when learning
   * is off. Takes precedence over {@link ServerDeps.observedCapability} when both
   * are set. Built server-side from the ledger + clock.
   */
  observedCapabilityByModel?: () => ObservedCapabilityByModel | undefined;
  /**
   * P6 §4: the difficulty-conditioned learned overlay, or `undefined` when
   * learning is off. Core consults it only for a difficulty-tagged task, so
   * threading it unconditionally never changes an untagged route.
   */
  observedCapabilityByModelDifficulty?: () => ObservedCapabilityByModelDifficulty | undefined;
  /**
   * P2: the rankings capability-prior posture for a (model-resolved) lane set —
   * `off` / `error` (flag on, snapshot bad; warning to surface) / `on` (overlay +
   * staleness + snapshot meta). Built server-side from ONE loader so
   * router_preview and router_delegate apply the SAME prior (no /why-vs-run
   * divergence). Absent (old hosts/fakes) ⇒ treated as off.
   */
  capabilityPrior?: (lanes: readonly Lane[]) => CapabilityPriorState;
  /** The active routing policy (from policy.yaml via core/node). */
  loadPolicy: () => Policy;
  /**
   * The server's effective safety-gate posture. router_preview defaults to this
   * (so /tokenmaxed:why matches what router_delegate would actually do); the
   * caller can still override per-call with `gate_ready`.
   */
  gateReady: boolean;
  /**
   * F: this adapter's host id (TOKENMAXED_HOST), threaded into every preview
   * RouteContext so lanes with a `hosts:` allowlist filter identically in
   * preview and delegate. Absent ⇒ unknown host ⇒ restricted lanes fail closed.
   */
  host?: string;
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
  /**
   * B: the routed-share quota headroom map (RouteContext.capHeadroom) for a lane
   * set, or undefined when no lane configures quotas — built server-side from
   * the SAME ledger delegate routes with (parity). Absent dep ⇒ no pressure.
   */
  capHeadroom?: (lanes: readonly Lane[]) => Record<string, number> | undefined;
  /** B: compact per-lane quota detail ("5h 12/40 routed · …") for /why lines. */
  quotaDetail?: (lane: Lane) => string | undefined;
  /** Lane health routing: the health penalty map for the RouteContext. */
  healthPenalty?: (lanes: readonly Lane[]) => Record<string, number> | undefined;
  /** Lane health routing: detailed health description for /why + status. */
  healthDetail?: (lane: Lane) => string | undefined;
  /**
   * B3/B4: one advisory line per warn/critical quota lane — routed-share detail,
   * an omit-first depletion projection, and the per-category overflow plan
   * (pure preview re-routing with the capped lane excluded; nothing executes).
   * Probes availability, so it is called only by status/summary — never hooks.
   */
  quotaAlerts?: () => Promise<string[]>;
  /**
   * A4: the persistent-settings report (per key: effective value + which layer —
   * env/settings/default — supplied it). Powers /tokenmaxed:config. Optional so
   * fakes/old hosts can omit the whole surface.
   */
  settings?: () => SettingsReport;
  /** A4: write (value) or clear (null) ONE known setting in settings.json. */
  setSetting?: (key: SettingKey, value: boolean | number | null) => void;
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
  /** Get currently configured reader lanes. */
  readerLanes?: () => Lane[];
  /** Get all configured lanes. */
  allLanes?: () => Lane[];
  /** Read the project's capacity reservations. */
  getReserves?: () => Record<string, number>;
  /** Set (lane/model, fraction) or clear capacity reservations. */
  setReserve?: (lane: string | undefined, fraction: number | undefined) => void;
  /** Read the project's target datetimes. */
  getTargets?: () => Record<string, string>;
  /** Set (lane/model, isoString) or clear target datetimes. */
  setTarget?: (lane: string | undefined, until: string | undefined) => void;
  /** Read the project's manual calibrations. */
  getCalibrations?: () => Record<string, number>;
  /** Set (lane/model, fraction) or clear manual calibrations. */
  setCalibration?: (lane: string | undefined, fraction: number | undefined) => void;
  /** Read the project's Reader -> Full-Access Grants list (including environment fallbacks). */
  getFullAccess?: (lanes?: readonly Lane[]) => string[];
  /** Grant a model name/id full access to the repository. */
  grantFullAccess?: (model: string) => void;
  /** Revoke a model name/id (or all models when model is empty) full access. */
  revokeFullAccess?: (model?: string) => void;
  /**
   * Whether YOLO mode (the `--dangerously-skip-permissions` analogue) is on for this
   * project — forces every trust/egress gate open so ALL worker/reader lanes are
   * selectable. router_preview routes with this (so /tokenmaxed:why matches the real
   * run) and router_status surfaces it. Absent ⇒ off (normal gated routing).
   */
  getYolo?: () => boolean;
  /** Set (true)/clear (false) the per-project YOLO mode. Powers /tokenmaxed:yolo. */
  setYolo?: (on: boolean) => void;
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
  /**
   * P2: rankings capability-prior posture (TOKENMAXED_CAPABILITY_PRIOR) — meta
   * only, never the overlay itself (setup reports, it doesn't route).
   */
  capabilityPrior:
    | { state: 'off' }
    | { state: 'error'; warning: string }
    | { state: 'on'; stale: boolean; source: string; generated: string; categories: string[]; unrankedCount: number };
  /** A4: settings-file state — present ONLY when ~/.tokenmaxed/settings.json exists (byte-compat when absent). */
  settings?: { path: string; applied: string[]; warning?: string };
  /** F-2: whether reader-egress is enabled (TOKENMAXED_READER_EGRESS). */
  readerEgress: boolean;
  /** MODEL-TIERS: whether tiered routing is enabled (TOKENMAXED_TIERED). */
  tiered: boolean;
  /** YOLO: whether the project default for YOLO mode is on (TOKENMAXED_YOLO env fallback; per-project state can still override at runtime). */
  yolo: boolean;
  /** SETUP-1: per-lane confirmation rows (model/trust/permissions/role/availability). */
  lanes: LaneSetupRow[];
  /**
   * SETUP-1 B: lane-review state for this project vs the configured lane set —
   * 'first-review' (never reviewed here), 'changed' (config changed since last review),
   * or 'current'. Setup marks the set as reviewed when it runs.
   */
  laneReview: 'first-review' | 'changed' | 'current';
  /**
   * If an ENABLED api/BYOK lane belongs to a vendor that also ships a Claude Code CLI
   * plugin (subscription, $0 metered), a nudge to use the plugin instead of the key.
   */
  pluginSuggestions?: { laneId: string; vendor: string; plugin: string; url: string }[];
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
  /**
   * OPTIONAL access requirement (tandem routing). `repo-tight` means the task needs
   * full repo/tool/shell access, so it routes straight to a full-access lane (worker
   * and reader lanes are skipped). `worker-ok` permits a worker. `auto` (default) is
   * resolved by the server — today always to `worker-ok`, with the worker give-back
   * as the safety net for a repo-tight miss. Orthogonal to the data-egress policy.
   */
  access_need?: AccessNeedInput;
  /**
   * OPTIONAL expected difficulty (P6 §4). When set AND learned difficulty
   * evidence exists for a candidate's model, routing conditions capability on
   * that difficulty's pass record (e.g. `hard` favors models that keep passing
   * hard reviews). Absent ⇒ category-level routing, unchanged.
   */
  difficulty?: DifficultyBucket;
  /**
   * OPTIONAL per-request model PIN — set ONLY when the USER explicitly named a
   * model in their prompt ("use minimax for this"). Routing is restricted to
   * the configured lane(s) serving that model (case-insensitive; a family name
   * pins its resolution). If no connected lane serves it — or the lane can't
   * run under current gates — the task comes back native with the reason:
   * TokenMaxed never substitutes another model for an explicit pin.
   */
  model?: string;
  /**
   * OPTIONAL. Set ONLY when the user explicitly authorized full repo access for the model
   * named in `model` — elevates that reader lane to full repo access for THIS call.
   * Requires `model`. Never infer it.
   */
  full_access?: boolean;
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
  fullAccessGranted?: boolean;
  fullAccessLaneIds?: string[];
  categoryInferred?: boolean;
  inferredConfidence?: number;
  hint?: string;
  /** A3: content-free receipt for this offload's executed legs (absent ⇒ nothing ran). */
  receipt?: DelegateReceipt;
}

/**
 * A3 ambient receipt — the per-offload "which model, what it cost, what it
 * saved" line rendered inline with every delegation result (trust research:
 * visibility IS the product). Content-free by construction: numbers only,
 * aggregated from the same recorded task legs the ledger keeps.
 */
export interface DelegateReceipt {
  tokensIn: number;
  tokensOut: number;
  /** true ⇒ token counts include estimated parts (some CLIs don't report exact usage). */
  tokensEstimated: boolean;
  /** Real metered dollars spent across ALL legs (subscription/local legs are $0 metered). */
  spentUsd: number;
  /**
   * Estimated metered-API dollars avoided, computed with the ledger's honest
   * net (`summarize()`): baseline from DELIVERED (ok, non-superseded) legs
   * minus metered spend across ALL legs — so a failed/discarded attempt that
   * cost real money makes this ≤ 0 rather than being ignored.
   */
  meteredAvoidedUsd: number;
  /** Executed task legs (1 = single pass; more ⇒ rework/escalation legs ran). */
  legs: number;
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
const ACCESS_NEEDS: readonly AccessNeedInput[] = ['worker-ok', 'repo-tight', 'auto'];
// Local value list (tools.ts imports core types ONLY — see the module banner);
// kept in sync with core's DIFFICULTY_BUCKETS by the type annotation.
const DIFFICULTIES: readonly DifficultyBucket[] = ['easy', 'moderate', 'hard'];
// A4: settable keys for router_config — typed against settings.ts (types only;
// the value module imports node:fs, which this file must not pull in).
const SETTING_KEYS_UI: readonly SettingKey[] = [
  'gate_ready', 'escalate', 'learn_capability', 'capability_prior', 'reader_egress',
  'tiered', 'tier_floor', 'review_on_stop', 'review_max_rounds',
];
const NUMERIC_SETTING_KEYS: ReadonlySet<SettingKey> = new Set(['tier_floor', 'review_max_rounds'] as const);

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
        // B4: append the overflow plan for capped lanes (advisory; computed by
        // pure preview re-routing — nothing executes). Fail-open to nothing.
        const alerts = deps.quotaAlerts ? await deps.quotaAlerts() : [];
        const banner =
          alerts.length > 0
            ? `${formatSummaryBanner(data)}\n   Quota (routed share only):\n${alerts.map((a) => `     ${a}`).join('\n')}`
            : formatSummaryBanner(data);
        return ok(banner, { summary: data as unknown as Record<string, unknown>, ...(alerts.length ? { quotaAlerts: alerts } : {}) });
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
        access_need: {
          type: 'string',
          enum: [...ACCESS_NEEDS],
          description:
            'OPTIONAL access requirement to preview. "repo-tight" filters worker/reader lanes out (only full-access lanes survive); "worker-ok"/"auto" (default) impose no access restriction — matching what router_delegate would route with.',
        },
        difficulty: {
          type: 'string',
          enum: [...DIFFICULTIES],
          description:
            'OPTIONAL difficulty to preview — shows the pick a difficulty-tagged delegate would make when learned difficulty evidence exists. Omit for the category-level pick.',
        },
        model: {
          type: 'string',
          description:
            'OPTIONAL exact-model pin to preview — shows what a model-pinned delegate would do (the pinned lane, or WHY the pin cannot run). Same matching as router_delegate\'s model param.',
        },
        full_access: {
          type: 'boolean',
          description:
            'OPTIONAL. Set ONLY when the user explicitly authorized full repo access for the model named in `model` — elevates that reader lane to full repo access for THIS call. Requires `model`. Never infer it.',
        },
      },
    },
    handler: (deps, args) =>
      guardedAsync(async () => {
        const category = optEnum(args, 'category', core.taskCategories);
        if (category === undefined) throw new ToolInputError('"category" is required.');
        const repo_class = optEnum(args, 'repo_class', REPO_CLASSES);
        const sensitivity = optEnum(args, 'sensitivity', SENSITIVITIES);
        const access_need = optEnum(args, 'access_need', ACCESS_NEEDS);
        const difficulty = optEnum(args, 'difficulty', DIFFICULTIES);
        const pinnedModel = optString(args, 'model')?.trim() || undefined;
        const full_access = optBool(args, 'full_access');
        if (full_access && !pinnedModel) {
          throw new ToolInputError('full_access requires a model pin.');
        }
        // The Task both ctx builds route on — difficulty rides it so the preview
        // matches what a difficulty-tagged router_delegate would decide.
        const task: Task = { category, ...(difficulty ? { difficulty } : {}) };
        // Mirror inferAccessNeed for the instruction-less preview case: an explicit
        // `repo-tight` is honored; `auto`/`worker-ok`/unset ⇒ `worker-ok` (no
        // restriction). Preview has no instruction/files, so a future heuristic that
        // reads them would need them threaded here to keep exact delegate parity.
        const resolvedAccessNeed: AccessNeed = access_need === 'repo-tight' ? 'repo-tight' : 'worker-ok';

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
        // YOLO mode (--dangerously-skip-permissions analogue): when on, routing forces
        // every trust/egress gate open. Mirror delegate's posture so /tokenmaxed:why
        // shows the same (possibly worker/reader) pick it would actually route to.
        const yolo = deps.getYolo?.() ?? false;

        const policyContext: PolicyContext = {
          ...(repo_class ? { repo_class } : {}),
          ...(sensitivity ? { sensitivity } : {}),
        };
        // Route over the category's candidate lanes (capability-0 opt-outs excluded),
        // matching the documented run path — never the full lane set.
        // Per-request model PIN (delegate parity): a pinned lane is NEVER
        // reserved away as a reviewer (delegate keeps it executing), so the pin
        // must look at the UNRESERVED candidate set — otherwise /why would call
        // a review-eligible pinned model "not connected" while delegate runs it.
        let lanes = deps.candidateLanes(category, pinnedModel ? { includeReserved: true } : undefined);
        const policy = deps.loadPolicy();
        // Restrict to lanes serving the named model; none connected ⇒ say so —
        // never preview a substitute.
        if (pinnedModel) {
          const pinnedLanes = lanes.filter((l) => core.modelMatchesPin(l.model, pinnedModel));
          if (pinnedLanes.length === 0) {
            const connected = [...new Set(lanes.map((l) => l.model))].sort();
            return ok(
              `requested model "${pinnedModel}" is not connected to TokenMaxed for category "${category}" — a model-pinned delegate would come back native (no substitution). Connected models: ${connected.join(', ') || '(none)'}.`,
              { category, gateReady, decision: null, native: true, pinnedModel, connectedModels: connected },
            );
          }
          lanes = pinnedLanes;
        }
        // Apply the learned overlay (F-1) so /tokenmaxed:why reflects the same
        // effective capability router_delegate routes with. Undefined ⇒ declared.
        const observedCapability = deps.observedCapability();
        const observedCapabilityByModel = deps.observedCapabilityByModel?.();
        // P6 §4: consulted by core only when the previewed task carries a difficulty.
        const observedCapabilityByModelDifficulty = deps.observedCapabilityByModelDifficulty?.();
        // P2: the rankings prior — the SAME loader delegate uses, so /why shows the
        // same prior-adjusted pick. 'off'/'error' (or an absent dep) ⇒ no ctx fields
        // ⇒ declared priors, byte-identical to before. NOTE: under escalation the
        // preview lane set excludes the reserved reviewer lane, so the overlay's
        // unranked COUNT is scoped to the lanes previewed (per-lane entries are
        // independent, so shared lanes' prior values — and the pick — still match
        // the real run; the banner wording scopes the count accordingly).
        const capPrior = deps.capabilityPrior?.(lanes);
        const priorCtx: Partial<RouteContext> =
          capPrior?.state === 'on'
            ? { capabilityPrior: capPrior.overlay, ...(capPrior.stale ? { capabilityPriorStale: true } : {}) }
            : {};
        // B: the same routed-share headroom map delegate routes with (parity).
        const capHeadroom = deps.capHeadroom?.(lanes);
        const quotaCtx: Partial<RouteContext> = capHeadroom ? { capHeadroom } : {};
        const healthPenalty = deps.healthPenalty?.(lanes);
        const healthCtx: Partial<RouteContext> = healthPenalty ? { healthPenalty } : {};
        const grants = deps.getFullAccess ? deps.getFullAccess(lanes) : [];
        const fullAccessLaneIds: string[] = [];
        for (const lane of lanes) {
          if (lane.trust_mode === 'reader') {
            const matchesProjectOrEnvGrant = grants.some((g) => g.toLowerCase() === lane.id.toLowerCase());
            const matchesPromptPin = !!full_access && !!pinnedModel && core.modelMatchesPin(lane.model, pinnedModel);
            if (matchesProjectOrEnvGrant || matchesPromptPin) {
              fullAccessLaneIds.push(lane.id);
            }
          }
        }

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
            access_need: resolvedAccessNeed,
            ...(deps.host ? { host: deps.host } : {}),
            ...(yolo ? { yolo: true } : {}),
            ...(observedCapability ? { observedCapability } : {}),
            ...(observedCapabilityByModel ? { observedCapabilityByModel } : {}),
            ...(observedCapabilityByModelDifficulty ? { observedCapabilityByModelDifficulty } : {}),
            ...priorCtx,
            ...quotaCtx,
            ...healthCtx,
            ...(fullAccessLaneIds.length ? { fullAccessLaneIds } : {}),
          };
          const eligible = core.eligibleLanes(task, baseCtx, policy).map((e) => e.lane);
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
          access_need: resolvedAccessNeed,
          ...(deps.host ? { host: deps.host } : {}),
          ...(yolo ? { yolo: true } : {}),
          ...(observedCapability ? { observedCapability } : {}),
          ...(observedCapabilityByModel ? { observedCapabilityByModel } : {}),
          ...(observedCapabilityByModelDifficulty ? { observedCapabilityByModelDifficulty } : {}),
          ...priorCtx,
          ...quotaCtx,
          ...healthCtx,
          ...(availableIds ? { availableLaneIds: availableIds } : {}),
          ...tieredCtx,
          ...(preferLaneId ? { preferLaneId } : {}),
          ...(fullAccessLaneIds.length ? { fullAccessLaneIds } : {}),
        };

        let decision: RouteDecision;
        try {
          decision = core.routeDecide(task, ctx, policy);
        } catch {
          // No selectable lane (all gated/blocked/unavailable) ⇒ the host does it.
          if (pinnedModel) {
            return ok(
              `requested model "${pinnedModel}" cannot run right now (its lane is blocked or unavailable under current gates) — a model-pinned delegate would come back native, NOT substitute another model.`,
              { category, gateReady, policyContext, decision: null, native: true, pinnedModel, fullAccessLaneIds },
            );
          }
          return ok(
            `category "${category}": no eligible lane (gate_ready=${gateReady}) — would run on the host (native).`,
            { category, gateReady, policyContext, decision: null, native: true, fullAccessLaneIds },
          );
        }

        const lane = lanes.find((l) => l.id === decision.laneId);
        // Surface the policy verdict explicitly so /router:why can explain a forced lane.
        const elevated = lane ? (core.isReaderElevated?.(lane, fullAccessLaneIds) ?? false) : false;
        const verdict = lane ? core.evaluate({ category }, lane, policyContext, policy, elevated).verdict : decision.policyVerdict;
        // When a preferred lane is set but did NOT win, say why it fell back — so the
        // user isn't surprised the "use lane X for now" override didn't apply here.
        const preferNote =
          preferLaneId && decision.laneId !== preferLaneId
            ? `  note: preferred lane "${preferLaneId}" was not used — it isn't eligible, available, or capable for this category (fell back to normal routing).`
            : undefined;
        // When YOLO is on, a worker/reader lane may win against a `force-trusted`
        // verdict that would normally restrict the task to a full lane — say so, so the
        // pick isn't mistaken for a normal gated decision.
        const yoloNote = yolo
          ? `  ⚠️ YOLO mode ON: trust/egress gates are bypassed — workers/readers are selectable even on private/sensitive/unknown context. Disable with /tokenmaxed:yolo off.`
          : undefined;
        // B: quota-pressure visibility — detected via the ACTUAL score factors
        // (no threshold duplication): a nonzero capPenalty on the winner means
        // pressure applied yet it still won; on losers it means they were
        // deprioritized. Preference overriding pressure is called out loudly.
        const quotaLines: string[] = [];
        const winnerCapPenalty = decision.scores.find((s) => s.laneId === decision.laneId)?.factors.capPenalty ?? 0;
        if (winnerCapPenalty > 0) {
          const detail = lane ? deps.quotaDetail?.(lane) : undefined;
          quotaLines.push(`  quota: ${detail ?? 'near cap'} — pressure applied; it won anyway (no better capable alternative)`);
          if (preferLaneId === decision.laneId) {
            quotaLines.push(`  ⚠ preferred lane overrides quota pressure${detail ? ` (${detail})` : ''} — /tokenmaxed:prefer off to release it.`);
          }
        }
        const resolveCalibrationFractionLocal = (lane: Lane, calibrations: Record<string, number>): number | undefined => {
          const laneIdLower = lane.id.toLowerCase();
          const laneModelLower = lane.model.toLowerCase();
          for (const [key, fraction] of Object.entries(calibrations)) {
            if (key.toLowerCase() === laneIdLower) return fraction;
          }
          for (const [key, fraction] of Object.entries(calibrations)) {
            if (key.toLowerCase() === laneModelLower) return fraction;
          }
          for (const [key, fraction] of Object.entries(calibrations)) {
            if (core.modelMatchesPin(lane.model, key)) return fraction;
          }
          return undefined;
        };

        const getDeprioritizedLabel = (laneId: string): string => {
          const l = lanes.find((x) => x.id === laneId);
          if (!l || !core.laneQuotaState) return `${laneId} (routed-share near cap)`;
          
          const calibrations = deps.getCalibrations?.() ?? {};
          const calOverride = resolveCalibrationFractionLocal(l, calibrations);
          if (calOverride === undefined) {
            return `${laneId} (routed-share near cap)`;
          }

          const events = deps.readLedger?.() ?? [];
          const now = deps.now();
          const laneWithCal = { ...l, calibration_fraction: calOverride };
          const s = core.laneQuotaState(events, laneWithCal, now);
          const sRaw = core.laneQuotaState(events, l, now);
          
          const hasWindow = typeof l.requests_per_window === 'number' && l.requests_per_window > 0;
          const hasWeekRequests = typeof l.requests_per_week === 'number' && l.requests_per_week > 0;
          const hasWeekTokens = typeof l.tokens_per_week === 'number' && l.tokens_per_week > 0;

          const r = Math.max(0, Math.min(0.9999, l.reserve_fraction ?? 0));
          const mult = 1 / (1 - r);
          let isCalDerived = false;
          const maxCalPct = Math.round(calOverride * 100);

          let maxUsedValue = -Infinity;
          let bindingAxis: 'window' | 'weekRequests' | 'weekTokens' | undefined = undefined;

          if (hasWindow && s.window) {
            if (s.window.used > maxUsedValue) {
              maxUsedValue = s.window.used;
              bindingAxis = 'window';
            }
          }
          if (hasWeekRequests && s.weekRequests) {
            if (s.weekRequests.used > maxUsedValue) {
              maxUsedValue = s.weekRequests.used;
              bindingAxis = 'weekRequests';
            }
          }
          if (hasWeekTokens && s.weekTokens) {
            if (s.weekTokens.used > maxUsedValue) {
              maxUsedValue = s.weekTokens.used;
              bindingAxis = 'weekTokens';
            }
          }

          if (bindingAxis === 'window' && s.window && sRaw.window) {
            const rawUsed = sRaw.window.used / mult;
            if (calOverride >= rawUsed) isCalDerived = true;
          } else if (bindingAxis === 'weekRequests' && s.weekRequests && sRaw.weekRequests) {
            const rawUsed = sRaw.weekRequests.used / mult;
            if (calOverride >= rawUsed) isCalDerived = true;
          } else if (bindingAxis === 'weekTokens' && s.weekTokens && sRaw.weekTokens) {
            const rawUsed = sRaw.weekTokens.used / mult;
            if (calOverride >= rawUsed) isCalDerived = true;
          }

          if (isCalDerived) {
            return `${laneId} (you reported ~${maxCalPct}% used)`;
          }
          return `${laneId} (routed-share near cap)`;
        };

        const pressuredLosers = decision.scores
          .filter((s) => s.laneId !== decision.laneId && s.factors.capPenalty > 0)
          .map((s) => s.laneId);
        if (pressuredLosers.length > 0) {
          const labels = pressuredLosers.map(getDeprioritizedLabel);
          quotaLines.push(`  quota-deprioritized: ${labels.join(', ')}`);
        }
        // P2: say where the winner's capability PRIOR came from (rankings overlay vs
        // declared config), and describe the active snapshot — or its load error —
        // so an adjusted score is never mistaken for a hand-set one.
        const priorLines: string[] = [];
        let priorStructured: Record<string, unknown> | undefined;
        if (capPrior?.state === 'on') {
          const m = capPrior.meta;
          priorLines.push(
            `  capability prior: ${m.source} (generated ${m.generated}${capPrior.stale ? '; STALE — no upward movement' : ''}) — categories ${m.categories.join('/')}; ${m.unrankedCount} of the previewed lane×category pairs unranked`,
          );
          const winnerPrior =
            lane && core.resolvedPriorFor
              ? core.resolvedPriorFor(lane, category, capPrior.overlay, { stale: capPrior.stale })
              : undefined;
          if (winnerPrior) {
            priorLines.push(
              `  prior for "${decision.laneId}": ${winnerPrior.provenance} ${winnerPrior.prior.toFixed(2)}${winnerPrior.clamped ? ' (clamped)' : ''}${winnerPrior.evidence ? ` [${winnerPrior.evidence.chart}, confidence ${winnerPrior.evidence.confidence}]` : ''}`,
            );
          }
          priorStructured = {
            state: 'on',
            stale: capPrior.stale,
            source: m.source,
            generated: m.generated,
            unrankedCount: m.unrankedCount,
            ...(winnerPrior ? { winnerProvenance: winnerPrior.provenance, winnerPrior: winnerPrior.prior, winnerClamped: winnerPrior.clamped ?? false } : {}),
          };
        } else if (capPrior?.state === 'error') {
          priorLines.push(`  capability prior: ERROR — ${capPrior.warning} (routing unaffected; declared capabilities in use)`);
          priorStructured = { state: 'error', warning: capPrior.warning };
        }
        // F: rejected-lane diagnostics — enumerate configured candidates rejected
        // specifically by HOST scope, via the SAME predicate routing uses (never
        // inferred from absence). Reason precedence: disabled beats host scope
        // (a disabled lane is not reported here), host beats structural/policy/
        // availability (those filters never saw the lane).
        const disabledIds = new Set(policy.disabledLaneIds ?? []);
        const hostBlocked = lanes.filter((l) => !disabledIds.has(l.id) && !core.hostAllowsLane(l, { host: deps.host }));
        const hostLines = hostBlocked.map(
          (l) =>
            `  host-blocked: ${l.id} (its hosts: list does not include '${deps.host ?? 'unknown'}'; adding it is YOUR acknowledgement of that vendor's terms for this host)`,
        );

        const healthLines: string[] = [];
        const winnerHealthDetail = lane ? deps.healthDetail?.(lane) : undefined;
        if (winnerHealthDetail) {
          healthLines.push(`  ${winnerHealthDetail}`);
        }

        const healthDeprioritizedLosers = decision.scores
          .filter((s) => s.laneId !== decision.laneId && (s.factors.healthPenalty ?? 0) > 0)
          .map((s) => {
            const l = lanes.find((x) => x.id === s.laneId);
            const detail = l ? deps.healthDetail?.(l) : undefined;
            return detail ? `${s.laneId} (${detail})` : s.laneId;
          });
        if (healthDeprioritizedLosers.length > 0) {
          healthLines.push(`  health-deprioritized: ${healthDeprioritizedLosers.join(', ')}`);
        }

        const text = [
          `category "${category}" → lane "${decision.laneId}"`,
          ...(pinnedModel ? [`  model pinned by request: "${pinnedModel}" — only lanes serving it were considered (no substitution on failure).`] : []),
          lane ? `  ${lane.kind} · ${lane.model} · trust=${lane.trust_mode}` : '  (lane not found in config)',
          `  policy verdict: ${verdict}`,
          `  why: ${decision.reason}`,
          ...(difficulty
            ? [
                `  difficulty: ${difficulty} — learned difficulty-specific evidence conditions capability when it exists (else category-level). Caveat: buckets reflect the depth at which review escalated under YOUR reviewer (an escalation-depth proxy), not ground-truth task complexity.`,
              ]
            : []),
          ...quotaLines,
          ...healthLines,
          ...priorLines,
          ...hostLines,
          ...(yoloNote ? [yoloNote] : []),
          ...(preferNote ? [preferNote] : []),
        ].join('\n');
        return ok(text, { category, gateReady, policyContext, decision, verdict, native: false, yolo, fullAccessLaneIds, ...(difficulty ? { difficulty } : {}), ...(priorStructured ? { capabilityPrior: priorStructured } : {}), ...(preferLaneId ? { preferLaneId } : {}), ...(hostBlocked.length > 0 ? { host: deps.host ?? null, hostBlocked: hostBlocked.map((l) => l.id) } : {}) });
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
        const yolo = deps.getYolo?.() ?? false;
        const lines = [`TokenMaxed routing is ${enabled ? 'ENABLED' : 'DISABLED'} for this project.`];
        if (yolo) {
          lines.push(
            '⚠️ YOLO mode is ON — every trust/egress gate is bypassed: ALL configured worker/reader lanes are selectable regardless of repo_class/sensitivity or per-lane attestation, and (possibly private) repo code may be sent to any configured vendor. The secret scanner still runs. Disable with /tokenmaxed:yolo off.',
          );
        }
        if (preferred) {
          lines.push(`Preferred lane: "${preferred}" (favored when eligible/available/capable; /tokenmaxed:prefer off to clear).`);
        }
        const reserves = deps.getReserves?.() ?? {};
        const reserveLines: string[] = [];
        for (const [key, val] of Object.entries(reserves)) {
          if (typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= 1) {
            const pct = Math.round(val * 100);
            reserveLines.push(`  ${key}: reserved ${pct}%`);
          }
        }
        if (reserveLines.length > 0) {
          lines.push('', 'Capacity reservations (project override):', ...reserveLines);
        }
        const calibrations = deps.getCalibrations?.() ?? {};
        const calibrationLines: string[] = [];
        for (const [key, val] of Object.entries(calibrations)) {
          if (typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= 1) {
            const pct = Math.round(val * 100);
            calibrationLines.push(`  ${key}: calibrated (you reported ${pct}% used)`);
          }
        }
        if (calibrationLines.length > 0) {
          lines.push('', 'Manual quota calibrations (project override):', ...calibrationLines);
        }
        const targets = deps.getTargets?.() ?? {};
        const targetLines: string[] = [];
        for (const [key, val] of Object.entries(targets)) {
          if (typeof val === 'string') {
            targetLines.push(`  ${key}: target last until ${val}`);
          }
        }
        if (targetLines.length > 0) {
          lines.push('', 'Pacing targets (project override):', ...targetLines);
        }
        const healthLines: string[] = [];
        if (enabled && deps.healthDetail) {
          const allLanesMap = new Map<string, Lane>();
          for (const cat of core.taskCategories) {
            const catLanes = deps.candidateLanes(cat, { includeReserved: true });
            for (const l of catLanes) {
              allLanesMap.set(l.id, l);
            }
          }
          for (const lane of allLanesMap.values()) {
            const detail = deps.healthDetail(lane);
            if (detail) {
              healthLines.push(`  ${lane.id}: ${detail}`);
            }
          }
        }
        if (healthLines.length > 0) {
          lines.push('', 'Lane Health:', ...healthLines);
        }
        // P2: the rankings-prior posture. Lanes aren't loaded on this read-only
        // path, so the meta line reports the snapshot itself (per-category lane
        // detail lives in /tokenmaxed:why). Rendered ONLY when on/error — the
        // default-off path stays byte-identical to before this feature (the
        // discovery hint lives in /tokenmaxed:setup, the surface that lists every
        // opt-in flag's off state).
        const capPrior = deps.capabilityPrior?.([]);
        if (capPrior?.state === 'on') {
          lines.push(
            `Capability prior: ON — ${capPrior.meta.source}, generated ${capPrior.meta.generated}, categories ${capPrior.meta.categories.join('/')}${capPrior.stale ? ', STALE (no upward movement)' : ''}.`,
          );
        } else if (capPrior?.state === 'error') {
          lines.push(`Capability prior: ERROR — ${capPrior.warning} (routing unaffected; declared capabilities in use).`);
        }
        // B3/B4: quota alerts (warn/critical lanes only ⇒ silent by default).
        const quotaAlerts = enabled && deps.quotaAlerts ? await deps.quotaAlerts() : [];
        if (quotaAlerts.length > 0) {
          const calibrationAlerts = quotaAlerts.filter((a) => a.includes('calibrated:'));
          const routedAlerts = quotaAlerts.filter((a) => !a.includes('calibrated:'));
          if (routedAlerts.length > 0) {
            lines.push('', 'Quota (routed share only — not your total subscription usage):', ...routedAlerts.map((a) => `  ${a}`));
          }
          if (calibrationAlerts.length > 0) {
            lines.push('', 'Quota (based on your manual calibrations):', ...calibrationAlerts.map((a) => `  ${a}`));
          }
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
          yolo,
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

  const setYoloTool: ToolDef = {
    name: 'router_set_yolo',
    description:
      "Turn YOLO mode ON or OFF for this project — the TokenMaxed analogue of Claude's --dangerously-skip-permissions. When ON, the router forces every trust/egress gate OPEN: ALL configured worker/reader lanes become selectable regardless of repo_class, sensitivity, the gate-ready/reader-egress opt-ins, or per-lane attestation, and a 'force-trusted' policy verdict no longer restricts a task to a full lane. This means (possibly private) repository code may be sent to ANY configured vendor lane. It does NOT disable the secret scanner, an explicit policy 'block' rule, the disabledLaneIds list, or the user-owned-config / RCE guard. The setting is persisted per project and survives restarts; the TOKENMAXED_DISABLE kill-switch always overrides it back off. Powers /tokenmaxed:yolo. Only enable on code you are comfortable sending to every lane you have configured.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled'],
      properties: {
        enabled: {
          type: 'boolean',
          description: 'true to turn YOLO mode ON (bypass all trust/egress gates), false to turn it OFF (normal gated routing).',
        },
      },
    },
    handler: (deps, args) =>
      guarded(() => {
        const enabled = optBool(args, 'enabled');
        if (enabled === undefined) throw new ToolInputError('"enabled" is required (boolean).');
        if (!deps.setYolo) throw new ToolInputError('YOLO mode is not supported by this server build.');
        deps.setYolo(enabled);
        const text = enabled
          ? '⚠️ YOLO mode ENABLED for this project — every trust/egress gate is bypassed: ALL configured worker/reader lanes are now selectable regardless of repo_class/sensitivity or per-lane attestation, and (possibly private) repo code may be sent to any configured vendor. The secret scanner, explicit policy `block` rules, and disabledLaneIds still apply. Run /tokenmaxed:yolo off to restore normal gated routing.'
          : 'YOLO mode DISABLED for this project — routing is back to normal gated behavior (trust/egress gates enforced).';
        return ok(text, { yolo: enabled });
      }),
  };

  const setReserveTool: ToolDef = {
    name: 'router_set_reserve',
    description:
      'Set or clear a capacity reservation fraction for a lane or model name in this project. When set, that fraction of the lane\'s quota is kept in reserve (daily/weekly limits are reached earlier). Use a percentage (0–100) or a decimal (0–1). If lane is empty, clears all reservations for the project. Powers /tokenmaxed:reserve.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lane: {
          type: 'string',
          description:
            'The lane ID or model name to reserve (e.g. claude-native or opus). If empty, clears all reservations for this project.',
        },
        fraction: {
          type: 'string',
          description:
            'The reservation fraction (e.g. "15%" or "0.15"). Use "off", "none", or "clear" to remove the reservation for this lane.',
        },
      },
    },
    handler: (deps, args) =>
      guarded(() => {
        const rawLane = optString(args, 'lane');
        const lane = typeof rawLane === 'string' ? rawLane.trim() : undefined;
        const rawFraction = optString(args, 'fraction');
        const fractionStr = typeof rawFraction === 'string' ? rawFraction.trim().toLowerCase() : undefined;

        if (!lane) {
          deps.setReserve?.(undefined, undefined);
          return ok(
            'All capacity reservations CLEARED for this project.',
            { reserves: null }
          );
        }

        if (!fractionStr || ['off', 'none', 'clear'].includes(fractionStr)) {
          deps.setReserve?.(lane, undefined);
          return ok(
            `Capacity reservation CLEARED for lane/model "${lane}" in this project.`,
            { lane, fraction: null }
          );
        }

        const numRegex = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
        let value: number;
        if (fractionStr.endsWith('%')) {
          const numPart = fractionStr.slice(0, -1);
          if (!numRegex.test(numPart)) {
            throw new ToolInputError(`Invalid percentage value: "${rawFraction}". Must be a number in 0–100%.`);
          }
          const parsed = Number(numPart);
          if (parsed < 0 || parsed > 100) {
            throw new ToolInputError(`Invalid percentage value: "${rawFraction}". Must be in range 0–100%.`);
          }
          value = parsed / 100;
        } else {
          if (!numRegex.test(fractionStr)) {
            throw new ToolInputError(`Invalid reservation value: "${rawFraction}". Must be a percentage (0–100) or decimal (0–1).`);
          }
          const parsed = Number(fractionStr);
          if (parsed >= 0 && parsed <= 1) {
            value = parsed;
          } else if (parsed > 1 && parsed <= 100 && !fractionStr.includes('.')) {
            value = parsed / 100;
          } else {
            throw new ToolInputError(`Invalid reservation value: "${rawFraction}". Must be a percentage in 0–100 or decimal in 0–1.`);
          }
        }

        const allLanes = deps.allLanes?.() ?? [];
        const matchedLanes = allLanes.filter((l) => core.modelMatchesPin(l.model, lane) || l.id.toLowerCase() === lane.toLowerCase());
        if (matchedLanes.length === 0) {
          const connectable = allLanes.map((l) => l.model).sort();
          throw new ToolInputError(
            `No connected lanes match "${lane}". Connected models: ${connectable.join(', ') || '(none)'}`
          );
        }

        deps.setReserve?.(lane, value);
        const pct = Math.round(value * 100);
        const resolvedNames = matchedLanes.map((l) => `${l.id} (${l.model})`).join(', ');
        return ok(
          `Capacity reservation of ${pct}% set for: ${resolvedNames} in this project.`,
          { lane, fraction: value, matchedLanes: matchedLanes.map((l) => l.id) }
        );
      }),
  };

  const setCalibrationTool: ToolDef = {
    name: 'router_set_calibration',
    description:
      'Set or clear a manual used-fraction calibration for a lane or model name in this project. When set, this used fraction acts as a floor for the lane\'s quota. Use a percentage (0–100) or a decimal (0–1). If lane is empty, clears all calibrations for the project. Powers /tokenmaxed:calibrate.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lane: {
          type: 'string',
          description:
            'The lane ID or model name to calibrate (e.g. claude-native or opus). If empty, clears all calibrations for this project.',
        },
        fraction: {
          type: 'string',
          description:
            'The calibration fraction (e.g. "70%" or "0.7"). Use "off", "none", or "clear" to remove the calibration for this lane.',
        },
      },
    },
    handler: (deps, args) =>
      guarded(() => {
        const rawLane = optString(args, 'lane');
        const lane = typeof rawLane === 'string' ? rawLane.trim() : undefined;
        const rawFraction = optString(args, 'fraction');
        const fractionStr = typeof rawFraction === 'string' ? rawFraction.trim().toLowerCase() : undefined;

        if (!lane) {
          deps.setCalibration?.(undefined, undefined);
          return ok(
            'All manual quota calibrations CLEARED for this project.',
            { calibrations: null }
          );
        }

        if (!fractionStr || ['off', 'none', 'clear'].includes(fractionStr)) {
          deps.setCalibration?.(lane, undefined);
          return ok(
            `Manual quota calibration CLEARED for lane/model "${lane}" in this project.`,
            { lane, fraction: null }
          );
        }

        const numRegex = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
        let value: number;
        if (fractionStr.endsWith('%')) {
          const numPart = fractionStr.slice(0, -1);
          if (!numRegex.test(numPart)) {
            throw new ToolInputError(`Invalid percentage value: "${rawFraction}". Must be a number in 0–100%.`);
          }
          const parsed = Number(numPart);
          if (parsed < 0 || parsed > 100) {
            throw new ToolInputError(`Invalid percentage value: "${rawFraction}". Must be in range 0–100%.`);
          }
          value = parsed / 100;
        } else {
          if (!numRegex.test(fractionStr)) {
            throw new ToolInputError(`Invalid calibration value: "${rawFraction}". Must be a percentage (0–100) or decimal (0–1).`);
          }
          const parsed = Number(fractionStr);
          if (parsed >= 0 && parsed <= 1) {
            value = parsed;
          } else if (parsed > 1 && parsed <= 100 && !fractionStr.includes('.')) {
            value = parsed / 100;
          } else {
            throw new ToolInputError(`Invalid calibration value: "${rawFraction}". Must be a percentage in 0–100 or decimal in 0–1.`);
          }
        }

        const allLanes = deps.allLanes?.() ?? [];
        const matchedLanes = allLanes.filter((l) => core.modelMatchesPin(l.model, lane) || l.id.toLowerCase() === lane.toLowerCase());
        if (matchedLanes.length === 0) {
          const connectable = allLanes.map((l) => l.model).sort();
          throw new ToolInputError(
            `No connected lanes match "${lane}". Connected models: ${connectable.join(', ') || '(none)'}`
          );
        }

        deps.setCalibration?.(lane, value);
        const pct = Math.round(value * 100);
        const resolvedNames = matchedLanes.map((l) => `${l.id} (${l.model})`).join(', ');
        return ok(
          `Manual quota calibration of ${pct}% set for: ${resolvedNames} in this project.`,
          { lane, fraction: value, matchedLanes: matchedLanes.map((l) => l.id) }
        );
      }),
  };

  const setTargetTool: ToolDef = {
    name: 'router_set_target',
    description:
      'Set or clear a pacing target datetime for a lane or model name in this project. Pacing will deprioritize the lane if its forecast depletion time is before the target. Value must be an ISO-8601 datetime string in the future. If lane is empty, clears all targets for the project. Powers /tokenmaxed:until.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lane: {
          type: 'string',
          description:
            'The lane ID or model name to target (e.g. claude-native or opus). If empty, clears all targets for this project.',
        },
        until: {
          type: 'string',
          description:
            'The target ISO-8601 datetime string (e.g. "2026-07-15T09:00"). Use "off", "none", or "clear" to remove the target for this lane.',
        },
      },
    },
    handler: (deps, args) =>
      guarded(() => {
        const rawLane = optString(args, 'lane');
        const lane = typeof rawLane === 'string' ? rawLane.trim() : undefined;
        const rawUntil = optString(args, 'until');
        const untilStr = typeof rawUntil === 'string' ? rawUntil.trim() : undefined;

        // 1. Validate 'until' field if supplied
        const isClearingTarget = !untilStr || ['off', 'none', 'clear'].includes(untilStr.toLowerCase());
        if (untilStr && !isClearingTarget) {
          if (!isValidIso8601(untilStr)) {
            throw new ToolInputError(`Invalid ISO datetime string: "${rawUntil}". Must be in strict ISO-8601 format.`);
          }
          const ms = Date.parse(untilStr);
          if (ms <= Date.now()) {
            throw new ToolInputError(`Invalid datetime: "${rawUntil}". Must be in the future.`);
          }
        }

        // 2. Validate 'lane' field if setting a target (not clearing)
        if (lane && untilStr && !isClearingTarget) {
          const allLanes = deps.allLanes?.() ?? [];
          const matchedLanes = allLanes.filter((l) => core.modelMatchesPin(l.model, lane) || l.id.toLowerCase() === lane.toLowerCase());
          if (matchedLanes.length === 0) {
            const connectable = allLanes.map((l) => l.model).sort();
            throw new ToolInputError(
              `No connected lanes match "${lane}". Connected models: ${connectable.join(', ') || '(none)'}`
            );
          }
        }

        // 3. Perform actions after all validations succeed
        if (!lane) {
          deps.setTarget?.(undefined, undefined);
          return ok(
            'All target datetimes CLEARED for this project.',
            { targets: null }
          );
        }

        if (isClearingTarget) {
          deps.setTarget?.(lane, undefined);
          return ok(
            `Target datetime CLEARED for lane/model "${lane}" in this project.`,
            { lane, until: null }
          );
        }

        deps.setTarget?.(lane, untilStr);
        const allLanes = deps.allLanes?.() ?? [];
        const matchedLanes = allLanes.filter((l) => core.modelMatchesPin(l.model, lane) || l.id.toLowerCase() === lane.toLowerCase());
        const resolvedNames = matchedLanes.map((l) => `${l.id} (${l.model})`).join(', ');
        return ok(
          `Target datetime of ${untilStr} set for: ${resolvedNames} in this project.`,
          { lane, until: untilStr, matchedLanes: matchedLanes.map((l) => l.id) }
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
      required: ['instruction'],
      properties: {
        category: {
          type: 'string',
          enum: [...core.taskCategories],
          description: 'OPTIONAL task category (drives lane choice). If omitted, it is inferred from the instruction.',
        },
        instruction: {
          type: 'string',
          description:
            'The self-contained subtask to perform. Include all needed context IN this text. A lane receives nothing else BEYOND any files you pass in `files` — no repo, no tools.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'OPTIONAL repo-relative file paths to attach VERBATIM so the lane sees real repo facts (e.g. the file being edited, a registry, test fixtures) instead of guessing — kills the "blind to your repo" hallucination class. Read server-side, path-confined to the project, then scrubbed + size-bounds + policy-gated by the minimizer (private-repo files require a reader-trust lane + its egress opt-in). Prefer naming the exact files over pasting paraphrased snippets.',
        },
        repo_class: { type: 'string', enum: [...REPO_CLASSES], description: 'Repository class for policy (default unknown).' },
        sensitivity: { type: 'string', enum: [...SENSITIVITIES], description: 'Content sensitivity for policy (default unknown).' },
        access_need: {
          type: 'string',
          enum: [...ACCESS_NEEDS],
          description:
            'OPTIONAL access requirement. "repo-tight" ⇒ the task needs full repo/tool/shell access, so it routes straight to a full-access lane (workers skipped). "worker-ok" ⇒ a worker may handle it. "auto" (default) lets the server decide (today: worker-ok, with worker give-back as the safety net). Orthogonal to repo_class/sensitivity policy.',
        },
        difficulty: {
          type: 'string',
          enum: [...DIFFICULTIES],
          description:
            'OPTIONAL expected difficulty. When set and learned difficulty-specific evidence exists (TOKENMAXED_LEARN_CAPABILITY), routing conditions capability on that difficulty\'s real pass record — e.g. "hard" favors models that keep passing hard reviews. Omit when unsure (category-level routing, unchanged).',
        },
        model: {
          type: 'string',
          description:
            'OPTIONAL exact-model pin. Set ONLY when the USER explicitly named a model in their prompt (e.g. "use minimax for this", "route this to gpt-5.5") — never infer it. Pass the VENDOR MODEL ID, normalizing obvious colloquial names first ("ChatGPT 5.5" → gpt-5.5, "Haiku" → claude-haiku); both exact versioned ids (gpt-5.5) and family names (minimax → its concrete resolution) match, case-insensitively. If the pin is refused as not connected, the reply lists the connected models: retry ONCE with the listed id when the user\'s intent maps to it unambiguously, otherwise relay the list and ask. TokenMaxed never substitutes a different model for an explicit pin. Omit for normal cheapest-capable routing.',
        },
        full_access: {
          type: 'boolean',
          description:
            'OPTIONAL. Set ONLY when the user explicitly authorized full repo access for the model named in `model` — elevates that reader lane to full repo access for THIS call. Requires `model`. Never infer it.',
        },
      },
    },
    handler: (deps, args) =>
      guardedAsync(async () => {
        const passedCategory = optEnum(args, 'category', core.taskCategories);
        const instruction = optString(args, 'instruction');
        if (!instruction || instruction.trim() === '') throw new ToolInputError('"instruction" is required (non-empty).');
        const files = optStringArray(args, 'files');
        const repo_class = optEnum(args, 'repo_class', REPO_CLASSES);
        const sensitivity = optEnum(args, 'sensitivity', SENSITIVITIES);
        const access_need = optEnum(args, 'access_need', ACCESS_NEEDS);
        const difficulty = optEnum(args, 'difficulty', DIFFICULTIES);
        const model = optString(args, 'model');
        const full_access = optBool(args, 'full_access');
        if (full_access && !model) {
          throw new ToolInputError('full_access requires a model pin.');
        }

        // Respect the per-project toggle: when off, never offload — tell the host
        // to do it itself (no config load, no execution).
        if (!deps.getEnabled()) {
          return ok(
            'TokenMaxed routing is DISABLED for this project — handle this task yourself (native). Run /tokenmaxed:on to re-enable.',
            { native: true, disabled: true },
          );
        }

        const resolution = resolveCategory(core, passedCategory, instruction);

        const policyContext: PolicyContext = {
          ...(repo_class ? { repo_class } : {}),
          ...(sensitivity ? { sensitivity } : {}),
        };
        const outcome = await deps.delegate({
          category: resolution.category,
          instruction,
          ...(Object.keys(policyContext).length ? { policyContext } : {}),
          ...(files && files.length ? { files } : {}),
          ...(access_need ? { access_need } : {}),
          ...(difficulty ? { difficulty } : {}),
          ...(model ? { model } : {}),
          ...(full_access !== undefined ? { full_access } : {}),
        });

        const finalOutcome = resolution.categoryInferred
          ? {
              ...outcome,
              categoryInferred: true,
              inferredConfidence: resolution.inferredConfidence,
              hint: resolution.hint,
            }
          : outcome;

        return renderDelegate(finalOutcome);
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
          // A4: rendered ONLY when the settings file exists (byte-compat when absent).
          ...(r.settings
            ? [
                `  settings: ${r.settings.path}${
                  r.settings.warning
                    ? ` — ⚠ ${r.settings.warning}`
                    : ` (${r.settings.applied.length ? `applies: ${r.settings.applied.join(', ')}` : 'no flags stored'}; /tokenmaxed:config to view/edit)`
                }`,
              ]
            : []),
          // P2: rendered ONLY when on/error — the default-off setup output stays
          // byte-identical to pre-P2 (the A1 gate; discoverability moves to the
          // A4 settings surface). The report FIELD is always present for hosts.
          ...(r.capabilityPrior.state === 'on'
            ? [
                `  capability prior: ON — ${r.capabilityPrior.source}, generated ${r.capabilityPrior.generated}, categories ${r.capabilityPrior.categories.join('/')}, ${r.capabilityPrior.unrankedCount} lane×category unranked${r.capabilityPrior.stale ? ', STALE (no upward movement)' : ''}`,
              ]
            : r.capabilityPrior.state === 'error'
              ? [`  capability prior: ERROR — ${r.capabilityPrior.warning} (routing unaffected; declared capabilities in use)`]
              : []),
          `  reader egress: ${r.readerEgress ? 'on' : 'off'} (enable with TOKENMAXED_READER_EGRESS=true — lets reader lanes receive repo-read code; also needs per-lane repo_read_attestation)`,
          `  tiered routing: ${r.tiered ? 'on' : 'off'} (enable with TOKENMAXED_TIERED=true — start on the cheapest lane clearing the capability floor, step up on review failure)`,
          `  YOLO mode: ${r.yolo ? '⚠️ ON (env default)' : 'off'} (the --dangerously-skip-permissions analogue: TOKENMAXED_YOLO=true or /tokenmaxed:yolo on — bypasses ALL trust/egress gates so every worker/reader lane is selectable; secret scanner still applies)`,
          '',
          ...(r.laneReview === 'changed'
            ? ['⚠ Your lanes changed since you last reviewed them — confirm the summary below.']
            : r.laneReview === 'first-review'
              ? ['ℹ Lane review: confirm what each lane may see/do below (recorded so you\'re reminded if it changes).']
              : []),
          ...formatLaneSetup(r.lanes),
          ...(r.pluginSuggestions && r.pluginSuggestions.length > 0
            ? [
                '',
                '💡 These enabled lanes authenticate with a BYOK API key. The vendor also ships a Claude',
                '   Code CLI plugin you can route on your flat-rate subscription instead — no key to manage',
                '   (and no metered spend for a pay-per-token key):',
                ...r.pluginSuggestions.map(
                  (s) => `   • ${s.laneId} (${s.vendor}) → ${s.plugin}: ${s.url}`,
                ),
              ]
            : []),
          '',
          `Next: edit ${r.lanesPath} to add/trust your lanes; for a BYOK api lane, set its key in env var TOKENMAXED_KEY_<authHandle>.`,
        ];
        return ok(lines.join('\n'), { ...r });
      }),
  };

  const configTool: ToolDef = {
    name: 'router_config',
    description:
      'Show or persist TokenMaxed feature settings (~/.tokenmaxed/settings.json) — the durable alternative to launch-time env flags. A real environment variable ALWAYS overrides a stored setting. The kill-switch (TOKENMAXED_DISABLE), YOLO mode, and API keys are deliberately NOT settable here. Powers /tokenmaxed:config.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: {
          type: 'string',
          enum: [...SETTING_KEYS_UI],
          description: 'OPTIONAL setting to show or change. Omit to list every setting with its effective value and source.',
        },
        value: {
          type: 'string',
          description:
            'OPTIONAL new value: "true"/"false" for the boolean flags, a number for tier_floor (0..1) / review_max_rounds (integer ≥ 1), or "clear" to remove the stored key. Omit to just show the key.',
        },
      },
    },
    handler: (deps, args) =>
      guardedAsync(async () => {
        if (!deps.settings) throw new ToolInputError('settings are not available on this host.');
        const key = optEnum(args, 'key', SETTING_KEYS_UI);
        const rawValue = optString(args, 'value');
        if (rawValue !== undefined && key === undefined) throw new ToolInputError('"value" requires "key".');

        if (key !== undefined && rawValue !== undefined) {
          if (!deps.setSetting) throw new ToolInputError('this host cannot write settings.');
          let parsed: boolean | number | null;
          if (rawValue === 'clear') parsed = null;
          else if (rawValue === 'true' || rawValue === 'false') parsed = rawValue === 'true';
          else if (NUMERIC_SETTING_KEYS.has(key) && Number.isFinite(Number(rawValue))) parsed = Number(rawValue);
          else throw new ToolInputError(`invalid value "${rawValue}" for "${key}" — use true/false${NUMERIC_SETTING_KEYS.has(key) ? ', a number,' : ''} or "clear".`);
          deps.setSetting(key, parsed); // throws with a clear message on invalid range/unwritable file
        }

        const report = deps.settings();
        const rows = key !== undefined && rawValue === undefined ? report.rows.filter((r) => r.key === key) : report.rows;
        const renderRow = (r: SettingsReport['rows'][number]): string => {
          const value = r.source === 'default' ? '(default)' : r.effective;
          const src = r.source === 'env' ? ` — env ${r.envVar} overrides` : r.source === 'settings' ? ' — from settings' : '';
          return `  ${r.key} = ${value}${src}`;
        };
        const lines = [
          `TokenMaxed settings (${report.path}${report.present ? '' : ' — not created yet'}):`,
          ...(report.warning ? [`  ⚠ ${report.warning}`] : []),
          ...(report.invalid.length ? [`  ⚠ ignored invalid value(s) for: ${report.invalid.join(', ')}`] : []),
          ...rows.map(renderRow),
          '',
          'Precedence: env var > settings.json > default. Set with /tokenmaxed:config <key> <value>; "clear" removes a stored key. The kill-switch, YOLO, and API keys stay env-only by design. When they apply: hooks and the statusline read settings on every run; the MCP server reads them at session start, so routing flags apply from your NEXT Claude Code session.',
        ];
        return ok(lines.join('\n'), { path: report.path, present: report.present, ...(report.warning ? { warning: report.warning } : {}), rows: rows as unknown as Record<string, unknown>[] });
      }),
  };

  const setFullAccessTool: ToolDef = {
    name: 'router_set_full_access',
    description:
      'Grant or revoke full repo access for a specific, named model in TokenMaxed reader lanes. When granted, that reader lane is selectable regardless of repo_class/sensitivity and receives the full, unminimized repo context verbatim. The fail-closed secret scanner still applies and output is reader-derived. Persistent per project. Powers /tokenmaxed:full-access.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        model: {
          type: 'string',
          description:
            'The model name/id to grant or revoke (e.g. minimax, gemini-1.5-pro). If empty/omitted and off is true, clears all grants for this project.',
        },
        off: {
          type: 'boolean',
          description:
            'Set to true to REVOKE access for the named model (or clear all grants if model is empty/omitted). Defaults to false (grant access).',
        },
      },
    },
    handler: (deps, args) =>
      guarded(() => {
        const raw = optString(args, 'model');
        const model = typeof raw === 'string' ? raw.trim() : undefined;
        const off = optBool(args, 'off') ?? false;

        if (off) {
          if (!model) {
            deps.revokeFullAccess?.();
            return ok(
              'Reader Full-Access Grants CLEARED for this project. TokenMaxed will route reader lanes with default permissions and minimization.',
              { fullAccessLaneIds: null }
            );
          } else {
            const allReaderLanes = deps.readerLanes?.() ?? [];
            const matchedLanes = allReaderLanes.filter((l) => core.modelMatchesPin(l.model, model) || l.id.toLowerCase() === model.toLowerCase());
            if (matchedLanes.length === 0) {
              throw new ToolInputError(`No connected reader lanes match "${model}".`);
            }
            for (const lane of matchedLanes) {
              deps.revokeFullAccess?.(lane.id);
            }
            const revokedNames = matchedLanes.map((l) => `${l.id} (${l.model})`).join(', ');
            return ok(
              `Reader Full-Access Grant REVOKED for: ${revokedNames} in this project. The secret scanner still applies and output remains reader-derived.`,
              { revokedLanes: matchedLanes.map((l) => l.id) }
            );
          }
        } else {
          if (!model) {
            throw new ToolInputError('"model" is required to grant full access.');
          }
          const allReaderLanes = deps.readerLanes?.() ?? [];
          const matchedLanes = allReaderLanes.filter((l) => core.modelMatchesPin(l.model, model));
          if (matchedLanes.length === 0) {
            const connectable = allReaderLanes.map((l) => l.model).sort();
            throw new ToolInputError(
              `No connected reader lanes match "${model}". Connected reader models: ${connectable.join(', ') || '(none)'}`
            );
          }
          for (const lane of matchedLanes) {
            deps.grantFullAccess?.(lane.id);
          }
          const grantedNames = matchedLanes.map((l) => `${l.id} (${l.model})`).join(', ');
          return ok(
            `Reader Full-Access GRANTED to: ${grantedNames} for this project.\n` +
              `· receives the full, unminimized repository context (attached files verbatim)\n` +
              `· is selectable regardless of repo class/sensitivity and safety gates\n` +
              `· the fail-closed secret scanner is still enforced (secrets block egress)\n` +
              `· output is reader-derived.`,
            { grantedLanes: matchedLanes.map((l) => l.id) }
          );
        }
      }),
  };

  return [savingsTool, tokensTool, summaryTool, previewTool, statusTool, setEnabledTool, setPreferTool, setFullAccessTool, setYoloTool, setReserveTool, setCalibrationTool, setTargetTool, delegateTool, reviewTool, setupTool, configTool];
}

/** Render a {@link DelegateOutcome} as an advisory directive to the host. */
/** A3: one compact, honest receipt line (est.-labeled tokens + finance-grade $). */
function receiptLine(r: DelegateReceipt): string {
  const int = (n: number): string => Math.round(n).toLocaleString('en-US');
  const usd = (n: number): string => (n < 0 ? `-$${Math.abs(n).toFixed(4)}` : `$${n.toFixed(4)}`);
  const legs = `${r.legs} leg${r.legs === 1 ? '' : 's'}`;
  return (
    `— receipt: ${int(r.tokensIn)} in / ${int(r.tokensOut)} out tok${r.tokensEstimated ? ' (est.)' : ''}` +
    ` · spent ${usd(r.spentUsd)} metered · est. ${usd(r.meteredAvoidedUsd)} metered avoided · ${legs}`
  );
}

function renderDelegate(o: DelegateOutcome): ToolResult {
  const inferenceFields = o.categoryInferred
    ? {
        categoryInferred: true,
        inferredConfidence: o.inferredConfidence,
        hint: o.hint,
      }
    : {};
  const inferenceText = o.categoryInferred && o.hint ? `\n\n${o.hint}` : '';
  // A3 ambient receipt: rendered on EVERY path where legs actually ran —
  // including a native give-back after failed/superseded legs, whose real spend
  // must never disappear just because the host finished the task.
  const receiptText = o.receipt ? `\n\n${receiptLine(o.receipt)}` : '';
  const receiptFields = o.receipt ? { receipt: o.receipt as unknown as Record<string, unknown> } : {};

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
    const fullAccessNote = o.fullAccessGranted
      ? '\n\n· ran with granted full repo access (reader-derived; secret scan still enforced)'
      : '';
    return ok(`Handle this task yourself (native): ${why}${reasonNote}.${note}${taint}${fullAccessNote}${receiptText}${inferenceText}`, {
      native: true,
      status: o.status,
      laneId: o.laneId,
      ...(o.reason ? { reason: o.reason } : {}),
      ...(o.failureKind ? { failureKind: o.failureKind } : {}),
      ...(o.readerDerived ? { readerDerived: true } : {}),
      ...(o.recordingFailed ? { recordingFailed: true } : {}),
      ...(o.fullAccessGranted ? { fullAccessGranted: true } : {}),
      ...(o.fullAccessLaneIds ? { fullAccessLaneIds: o.fullAccessLaneIds } : {}),
      ...receiptFields,
      ...inferenceFields,
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
  const fullAccessNote = o.fullAccessGranted
    ? '\n\n· ran with granted full repo access (reader-derived; secret scan still enforced)'
    : '';
  const fullAccessFlag = o.fullAccessGranted ? { fullAccessGranted: true } : {};

  // C-13: the offload produced output but the manager review couldn't run — the
  // result is UNREVIEWED, so do NOT tell the host to "use it"; flag it for review.
  if (o.reviewUnavailable) {
    return ok(
      `Offloaded to ${lane} — UNREVIEWED (${o.reason ?? 'manager review unavailable'}). Inspect it yourself before using:\n\n${o.resultText ?? ''}${taint}${fullAccessNote}${note}${receiptText}${inferenceText}`,
      { native: false, laneId: o.laneId, model: o.model, status: o.status, reviewUnavailable: true, ...(o.reason ? { reason: o.reason } : {}), ...taintFlag, ...fullAccessFlag, ...(o.fullAccessLaneIds ? { fullAccessLaneIds: o.fullAccessLaneIds } : {}), ...(o.recordingFailed ? { recordingFailed: true } : {}), ...receiptFields, ...inferenceFields },
    );
  }
  // C-13: `reason` may carry "escalated to X" / "reworked on X" (accept_after_*).
  const how = o.reason ? ` (${o.reason})` : '';
  return ok(`Offloaded to ${lane}${how}. Use this result:\n\n${o.resultText ?? ''}${taint}${fullAccessNote}${note}${receiptText}${inferenceText}`, {
    native: false,
    laneId: o.laneId,
    model: o.model,
    status: o.status,
    ...(o.reason ? { reason: o.reason } : {}),
    ...taintFlag,
    ...fullAccessFlag,
    ...(o.fullAccessLaneIds ? { fullAccessLaneIds: o.fullAccessLaneIds } : {}),
    ...(o.recordingFailed ? { recordingFailed: true } : {}),
    ...receiptFields,
    ...inferenceFields,
  });
}

export interface CategoryResolution {
  category: TaskCategory;
  categoryInferred: boolean;
  inferredConfidence?: number;
  hint?: string;
}

export function resolveCategory(
  core: {
    classifyTask: (text: string) => { category: TaskCategory; confidence: number };
    MIN_CLASSIFY_CONFIDENCE: number;
    CLASSIFY_FALLBACK_CATEGORY: TaskCategory;
  },
  passedCategory?: TaskCategory,
  instruction?: string,
): CategoryResolution {
  if (passedCategory !== undefined) {
    return {
      category: passedCategory,
      categoryInferred: false,
    };
  }
  const c = core.classifyTask(instruction ?? '');
  const resolvedCategory = c.confidence >= core.MIN_CLASSIFY_CONFIDENCE ? c.category : core.CLASSIFY_FALLBACK_CATEGORY;
  return {
    category: resolvedCategory,
    categoryInferred: true,
    inferredConfidence: c.confidence,
    hint: `category inferred as '${resolvedCategory}' (confidence ${c.confidence.toFixed(2)}) — pass an explicit category for precise routing.`,
  };
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
