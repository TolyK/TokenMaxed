/**
 * The routing brain: pure, deterministic, no I/O.
 *
 * `routeDecide` picks the right-sized lane for a task. The core score is a
 * lane's EFFECTIVE capability for the task's category minus a marginal-cost
 * penalty — where effective capability layers, in order: the declared config
 * prior (or the rankings prior overlay, P2), the learned model-keyed review
 * evidence (F-1/P6), and the difficulty-conditioned cell when the task carries
 * a bucket (P6 §4 back-off ladder). Quota pressure (B) deprioritizes near-cap
 * lanes via `capHeadroom`; the tiered strategy instead takes the cheapest lane
 * clearing a capability floor; an explicit `preferLaneId` overrides ranking
 * (never the hard rails). Candidates are pre-filtered by the structural
 * pre-gate, the data-egress policy, the access-need gate, and availability.
 * Ties break deterministically by lane id so the same inputs always yield the
 * same decision, and `decision.scores` explains every candidate (/why).
 */

import { isExecutorCertified, isReaderExecutorCertified } from './boundary.ts';
import { priorOptsFromContext, resolvedPriorFor, type ResolvedPriorOptions } from './capability-prior.ts';
import { parseModelAlias } from './model-freshness.ts';
import { evaluate, laneAllowedByVerdict } from './policy.ts';
import { TRUSTED_PROVENANCES } from './types.ts';
import type {
  CapabilityPriorOverlay,
  DifficultyBucket,
  ExecutionMode,
  Lane,
  LaneScore,
  ObservedCapability,
  ObservedCapabilityByLane,
  ObservedCapabilityByModel,
  ObservedCapabilityByModelDifficulty,
  Policy,
  PolicyVerdict,
  RouteContext,
  RouteDecision,
  Task,
} from './types.ts';

/** Capability assumed for a lane that declares no score for a category. */
export const DEFAULT_CAPABILITY = 0.5;

/**
 * Default shrinkage prior strength (pseudo-count) for {@link effectiveCapability}.
 * It takes roughly this much weighted review evidence to move the effective score
 * halfway from the declared prior toward the observed rate. Kept as a code
 * constant in v1 (not policy/env config) until real data shows tuning pressure.
 */
export const DEFAULT_PRIOR_STRENGTH = 8;

/**
 * Marginal-cost penalty per cost basis. Local and subscription lanes are ~free
 * at the margin, so they're preferred; metered (paid API) lanes are penalized.
 * The penalty is small relative to capability (see WEIGHTS) so a clearly more
 * capable lane still wins — cost only decides near-ties.
 */
const COST_PENALTY: Record<Lane['costBasis'], number> = {
  local: 0,
  subscription: 0.05,
  metered: 0.2,
};

const WEIGHTS = {
  capability: 1,
  cost: 1,
} as const;

/**
 * Cap-headroom penalty. Below the warn headroom a lane is gently deprioritized;
 * below the critical headroom it gets a large penalty so it is chosen only as a
 * last resort. Thresholds mirror usage.ts (warn at 70% used ⇒ 0.30 headroom,
 * critical at 90% used ⇒ 0.10 headroom).
 */
const CAP_WARN_HEADROOM = 0.3;
const CAP_CRITICAL_HEADROOM = 0.1;
const CAP_WARN_PENALTY = 0.15;
const CAP_CRITICAL_PENALTY = 1;
/** Tolerance so a headroom like 1 - 0.7 = 0.30000000000000004 still counts as the warn boundary. */
const CAP_EPSILON = 1e-9;

function capPenaltyFor(headroom: number | undefined): number {
  if (headroom === undefined || headroom > CAP_WARN_HEADROOM + CAP_EPSILON) return 0;
  if (headroom <= CAP_CRITICAL_HEADROOM + CAP_EPSILON) return CAP_CRITICAL_PENALTY;
  return CAP_WARN_PENALTY;
}

/**
 * Lane ids the user explicitly authorized to be elevated from `reader` to full repo access.
 * Returns true if the lane has a trust mode of 'reader' and its ID is present in the fullAccessLaneIds list.
 */
export function isReaderElevated(lane: Lane, fullAccessLaneIds?: readonly string[]): boolean {
  return lane.trust_mode === 'reader' && !!fullAccessLaneIds && fullAccessLaneIds.includes(lane.id);
}

/**
 * Enforcement order is law. A non-`full` lane (worker/reader/blocked) may run
 * ONLY once the minimization/policy gate is ready AND its executor is
 * egress-certified. Until then, only `full`, non-`api` lanes are selectable —
 * a hard structural guard independent of policy config. When the gate ships, the
 * policy engine takes over candidate filtering and this guard is relaxed
 * deliberately, not by accident.
 *
 * @param gateReady whether the minimization/policy gate is built + CI-green.
 *   Defaults to `false`. In this step it only relaxes the pre-gate "no API lane"
 *   restriction for full (trusted) lanes; worker admission lands with the policy
 *   engine + egress certification.
 * @param elevated whether this lane is elevated to full access.
 */
export function isSelectablePreGate(
  lane: Lane,
  gateReady = false,
  readerEgress = false,
  yolo = false,
  elevated = false,
): boolean {
  // YOLO (--dangerously-skip-permissions analogue): the trust-tier structural gate
  // (gate-ready, reader-egress opt-in, per-lane repo_read_attestation) is WAIVED, so
  // every tier is selectable EXCEPT `blocked`. The executor-certification checks
  // STAY: an egress-certified executor for the tier is a CODE-capability fact (a lane
  // without one would error at send), not a user permission. The secret scanner and
  // the user-owned-config / RCE guard live outside routing and are likewise unaffected.
  if (yolo) {
    if (lane.trust_mode === 'full') return true;
    if (lane.trust_mode === 'worker') return isExecutorCertified(lane);
    if (lane.trust_mode === 'reader') return isReaderExecutorCertified(lane);
    return false; // `blocked` (never) and any unknown/legacy value.
  }
  if (lane.trust_mode === 'reader' && elevated) {
    return isReaderExecutorCertified(lane);
  }
  // ALLOWLIST + fail-closed: only `full`/`worker`/`reader` have selectable logic.
  // Full (trusted, user-approved) lanes: CLI/local always selectable; an API lane
  // only once the gate is ready (the blanket pre-gate "no API lane" guard relaxes).
  if (lane.trust_mode === 'full') return gateReady || lane.kind !== 'api';
  // Untrusted `worker` lanes are admitted only when the gate is ready AND a
  // core-owned, egress-CI-certified executor exists for the lane. The policy gate
  // and the minimizer then apply on top (defense in depth) before anything sends.
  if (lane.trust_mode === 'worker') return gateReady && isExecutorCertified(lane);
  // `reader` (F-2 middle tier) is HIGH-FRICTION: selectable only with ALL of —
  // the gate ready, the global reader-egress opt-in, an egress-certified reader
  // executor (API-only in v1), AND the per-lane repo_read_attestation (the user's
  // "private code may go to this vendor" sign-off). The policy hard cap + the
  // minimizeForReader boundary then apply on top before anything sends.
  if (lane.trust_mode === 'reader') {
    return (
      readerEgress &&
      gateReady &&
      isReaderExecutorCertified(lane) &&
      lane.repo_read_attestation === true
    );
  }
  // Everything else fails CLOSED: `blocked` (never) and any unknown/legacy value
  // (e.g. a deprecated `monitored` reaching a direct JS caller without config
  // normalization).
  return false;
}

/**
 * Whether a lane is eligible to act as the manager/reviewer. Requires
 * `trust_mode: 'full'` + `manager_allowed` + (trusted-by-provenance/local OR an
 * explicit user attestation). Keeps an arbitrary BYOK lane from silently becoming
 * the reviewer just because a user marked it `full`.
 */
export function isManagerEligible(lane: Lane): boolean {
  if (lane.trust_mode !== 'full' || lane.manager_allowed !== true) return false;
  const trustedByOrigin = lane.kind === 'local' || TRUSTED_PROVENANCES.includes(lane.provenance);
  return trustedByOrigin || lane.attestation === true;
}

/** Resolve a lane's execution mode (defaults to `answer-only`). */
export function executionModeOf(lane: Lane): ExecutionMode {
  return lane.execution_mode ?? 'answer-only';
}

/**
 * Whether a lane can actually perform `repo-tight` work — i.e. has live repo/tool/
 * shell access. `trust_mode: 'full'` is necessary but NOT sufficient, and neither is
 * `execution_mode: 'agentic'` on its own: a full API or local lane only ever receives
 * prompt + attachments over its executor (no shell/tools/live repo), so it would
 * blind-guess repo-tight work exactly like a worker even if flagged agentic. The only
 * lanes that genuinely act on the repo are the native host lane (Claude Code itself)
 * and an agentic CLI lane (a spawned provider CLI allowed to edit files / run
 * commands locally).
 */
export function canDoRepoTight(lane: Lane): boolean {
  if (lane.trust_mode !== 'full') return false;
  return lane.native === true || (lane.kind === 'cli' && executionModeOf(lane) === 'agentic');
}

/** Clamp a number into [0, 1]. */
function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * The lane's DECLARED capability for a task category (the config prior),
 * defaulting when unspecified. This is the hand-assigned score from lane config;
 * it is never mutated by feedback. Use this where the declared value is the
 * intended semantics: reviewer/manager authority and the `capability: 0` opt-out.
 * For routing/reassignment/escalation-target selection, prefer
 * {@link effectiveCapabilityFor}, which blends in observed evidence.
 */
export function declaredCapabilityFor(lane: Lane, category: Task['category']): number {
  const declared = lane.capability?.[category];
  return clamp01(declared ?? DEFAULT_CAPABILITY);
}

/**
 * @deprecated Use {@link declaredCapabilityFor} (the config prior) or
 * {@link effectiveCapabilityFor} (prior blended with observed evidence). Retained
 * as a back-compat alias for external `@tokenmaxed/core` consumers; identical to
 * `declaredCapabilityFor`.
 */
export const capabilityFor = declaredCapabilityFor;

/** Options for {@link effectiveCapability} and {@link effectiveCapabilityFor}. */
export interface EffectiveCapabilityOptions {
  /**
   * Shrinkage prior strength (pseudo-count). Higher ⇒ more evidence required to
   * move away from the declared prior. Must be finite and > 0; otherwise
   * {@link DEFAULT_PRIOR_STRENGTH} is used.
   */
  priorStrength?: number;
  /**
   * Rankings prior overlay. When set, the prior slot uses {@link resolvedPriorFor}
   * instead of {@link declaredCapabilityFor}; absent ⇒ declared prior (unchanged).
   */
  priorOverlay?: CapabilityPriorOverlay;
  /** Staleness + accepted-prior state for rankings prior resolution. */
  priorOpts?: ResolvedPriorOptions;
  /**
   * Model-keyed observed overlay (P6). When set, observed evidence is read by
   * resolving the lane to its canonical model key via {@link resolveLaneModelKey}.
   */
  modelOverlay?: ObservedCapabilityByModel;
  /**
   * P6 §4: difficulty-conditioned observed overlay. Consulted only when
   * {@link EffectiveCapabilityOptions.difficulty} is also set — see the
   * back-off ladder note on {@link effectiveCapabilityFor}.
   */
  difficultyOverlay?: ObservedCapabilityByModelDifficulty;
  /** The task's difficulty bucket; enables the difficulty-cell blend when set. */
  difficulty?: DifficultyBucket;
}

/**
 * Resolve a lane's canonical model key for overlay lookup. Mirrors
 * {@link resolveLaneModelId} without a price table — the adapter pre-resolves
 * `@latest` before scoring, so unresolved aliases pass through unchanged.
 */
export function resolveLaneModelKey(lane: Lane): string {
  const spec = parseModelAlias(lane.model);
  return spec.latest ? lane.model : spec.id;
}

/** Observed evidence for a lane×category from model- or lane-keyed overlays. */
export function observedForLane(
  lane: Lane,
  category: Task['category'],
  laneOverlay?: ObservedCapabilityByLane,
  modelOverlay?: ObservedCapabilityByModel,
): ObservedCapability | undefined {
  if (modelOverlay) {
    return modelOverlay[resolveLaneModelKey(lane)]?.[category];
  }
  return laneOverlay?.[lane.id]?.[category];
}

/** Build effective-capability options from a route context when a prior overlay is present. */
export function effectiveCapabilityOptsFromContext(ctx: RouteContext): EffectiveCapabilityOptions | undefined {
  if (!ctx.capabilityPrior) return undefined;
  return {
    priorOverlay: ctx.capabilityPrior,
    priorOpts: priorOptsFromContext(ctx),
  };
}

/**
 * Task-aware effective-capability options: the context-level opts plus the
 * difficulty-cell inputs when BOTH the task carries a difficulty and the context
 * carries the difficulty-conditioned overlay (P6 §4). Undefined when nothing
 * applies — so callers passing the result through behave byte-identically to
 * before difficulty existed.
 */
export function effectiveOptsForTask(ctx: RouteContext, task: Task): EffectiveCapabilityOptions | undefined {
  const base = effectiveCapabilityOptsFromContext(ctx);
  const conditioned =
    task.difficulty && ctx.observedCapabilityByModelDifficulty
      ? { difficulty: task.difficulty, difficultyOverlay: ctx.observedCapabilityByModelDifficulty }
      : undefined;
  if (!base && !conditioned) return undefined;
  return { ...base, ...conditioned };
}

/**
 * P6 §4 back-off ladder, applied on top of a category-level effective
 * capability: when the options carry a difficulty + overlay and the lane's
 * model×category×difficulty cell has evidence, blend the cell toward the
 * category-level value with the SAME shrinkage form (k = priorStrength,
 * default {@link DEFAULT_PRIOR_STRENGTH}); otherwise return the category-level
 * value unchanged (difficulty cell → category cell → declared/prior). A
 * categoryLevel of 0 (the opt-out) short-circuits inside
 * {@link effectiveCapability} and can never be resurrected by a cell.
 */
function applyDifficultyCell(
  categoryLevel: number,
  lane: Lane,
  category: Task['category'],
  opts?: EffectiveCapabilityOptions,
): number {
  if (!opts?.difficulty || !opts.difficultyOverlay) return categoryLevel;
  const cell = opts.difficultyOverlay[resolveLaneModelKey(lane)]?.[category]?.[opts.difficulty];
  if (!cell) return categoryLevel;
  return effectiveCapability(categoryLevel, cell, { priorStrength: opts.priorStrength });
}

/**
 * Blend a declared capability prior with observed review evidence via shrinkage
 * toward the prior (F-1 capability feedback). Pure and total:
 *
 *   effective = (k·declared + n·rate) / (k + n)
 *
 * - No/low evidence (`n ≤ 0` or no `observed`) ⇒ returns the declared prior, so a
 *   single review can never swing routing and config still rules by default.
 * - Lots of evidence (`n ≫ k`) ⇒ converges toward the observed `rate`.
 *
 * All inputs are clamped: `declared`/`rate` into [0, 1]; a non-finite or
 * non-positive `n` is treated as 0 (⇒ declared); a non-finite or non-positive
 * `priorStrength` falls back to the default. Never divides by zero.
 */
export function effectiveCapability(
  declared: number,
  observed: ObservedCapability | undefined,
  opts: EffectiveCapabilityOptions = {},
): number {
  const prior = clamp01(declared);
  // An explicit declared 0 is a hard opt-out ("this lane cannot do this"), not a
  // weak prior: no amount of observed success may resurrect it. (Belt-and-braces
  // with LaneRegistry.candidateLanes, which also filters declared-0 lanes out.)
  if (prior === 0) return 0;
  if (!observed) return prior;
  const n = Number.isFinite(observed.n) && observed.n > 0 ? observed.n : 0;
  if (n === 0) return prior;
  const rate = clamp01(observed.rate);
  const k =
    Number.isFinite(opts.priorStrength) && (opts.priorStrength as number) > 0
      ? (opts.priorStrength as number)
      : DEFAULT_PRIOR_STRENGTH;
  return clamp01((k * prior + n * rate) / (k + n));
}

/**
 * A lane's EFFECTIVE capability for a category: its declared prior blended with
 * observed evidence from `overlay` (if any) for that lane×category. With no
 * overlay entry this is exactly {@link declaredCapabilityFor}, so callers that
 * pass no overlay (or `undefined`) behave identically to before the feedback loop.
 */
export function effectiveCapabilityFor(
  lane: Lane,
  category: Task['category'],
  overlay?: ObservedCapabilityByLane,
  opts?: EffectiveCapabilityOptions,
): number {
  const observed = observedForLane(lane, category, overlay, opts?.modelOverlay);
  if (opts?.priorOverlay) {
    const resolved = resolvedPriorFor(lane, category, opts.priorOverlay, opts.priorOpts);
    const categoryLevel = effectiveCapability(resolved.prior, observed, {
      priorStrength: opts.priorStrength ?? resolved.priorStrength,
    });
    return applyDifficultyCell(categoryLevel, lane, category, opts);
  }
  const declared = declaredCapabilityFor(lane, category);
  return applyDifficultyCell(effectiveCapability(declared, observed, opts), lane, category, opts);
}

function scoreLane(
  lane: Lane,
  task: Task,
  capHeadroom?: Record<string, number>,
  observedCapability?: ObservedCapabilityByLane,
  observedCapabilityByModel?: ObservedCapabilityByModel,
  effectiveOpts?: EffectiveCapabilityOptions,
  healthPenaltyMap?: Record<string, number>,
  laneCost?: Record<string, number>,
  routingPolicy?: 'balanced' | 'cheapest' | 'preserve-frontier' | 'reliable',
): LaneScore {
  const declared = declaredCapabilityFor(lane, task.category);
  const observed = observedForLane(lane, task.category, observedCapability, observedCapabilityByModel);
  const effOpts: EffectiveCapabilityOptions | undefined = observedCapabilityByModel
    ? { ...effectiveOpts, modelOverlay: observedCapabilityByModel }
    : effectiveOpts;
  // Route everything through effectiveCapabilityFor when ANY overlay input is in
  // play (prior overlay or a difficulty cell); the bare two-arg blend remains the
  // no-overlay fast path, byte-identical to pre-P2/P6 behavior.
  const capability =
    effOpts?.priorOverlay || (effOpts?.difficulty && effOpts?.difficultyOverlay)
      ? effectiveCapabilityFor(lane, task.category, observedCapability, effOpts)
      : effectiveCapability(declared, observed);
  const costPenaltyRaw = COST_PENALTY[lane.costBasis];
  const capPenalty = capPenaltyFor(capHeadroom?.[lane.id]);
  const healthPenaltyRaw = healthPenaltyMap?.[lane.id] ?? 0;
  let healthPenalty = (Number.isFinite(healthPenaltyRaw) && healthPenaltyRaw >= 0)
    ? Math.min(1.0, healthPenaltyRaw)
    : 0;

  // Future routing policies to consider:
  // - fastest: needs latency data (currently unavailable)
  // - explore: needs non-determinism (currently all routing is strictly deterministic)
  let costPenalty = costPenaltyRaw;
  if (routingPolicy === 'preserve-frontier') {
    const rawSignal = laneCost?.[lane.id];
    let costSignal = COST_PENALTY[lane.costBasis];
    let multiplier = 5.0;
    if (rawSignal !== undefined && Number.isFinite(rawSignal) && rawSignal >= 0) {
      costSignal = Math.min(1000000, rawSignal);
      multiplier = 0.2;
    }
    costPenalty += costSignal * multiplier;
  } else if (routingPolicy === 'reliable') {
    healthPenalty = healthPenalty * 5.0;
  }

  const score = WEIGHTS.capability * capability - WEIGHTS.cost * costPenalty - capPenalty - healthPenalty;
  const factors: LaneScore['factors'] = {
    capability,
    costPenalty,
    capPenalty,
    declared,
    evidenceN: observed?.n ?? 0,
  };
  if (healthPenaltyMap !== undefined) {
    factors.healthPenalty = healthPenalty;
  }
  return {
    laneId: lane.id,
    score,
    factors,
  };
}

/**
 * Order scores best-first with a fully deterministic tie-break:
 * higher score wins; on equal score, the lower lane id (ascending) wins.
 */
function compareScores(a: LaneScore, b: LaneScore): number {
  // A declared `capability: 0` (⇒ effective 0) is a HARD opt-out: it must rank below
  // ANY positive-capability lane, even when a cost penalty would otherwise lift its
  // raw score above a weak metered lane. It stays visible in `scores` but never wins.
  const az = a.factors.capability === 0;
  const bz = b.factors.capability === 0;
  if (az !== bz) return az ? 1 : -1;
  if (b.score !== a.score) return b.score - a.score;
  return a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0;
}

function describe(
  lane: Lane,
  best: LaneScore,
  task: Task,
  routingPolicy: 'balanced' | 'cheapest' | 'preserve-frontier' | 'reliable' | undefined,
  tiered = false,
  preferred = false,
): string {
  const f = best.factors;
  const cap = f.capability.toFixed(2);
  let reason = preferred
    ? `Selected ${lane.id} (${lane.model}) for ${task.category}: preferred lane (explicit offload), ` +
      `capability ${cap} at ${lane.costBasis} cost.`
    : tiered
      ? `Selected ${lane.id} (${lane.model}) for ${task.category}: cheapest lane clearing the ` +
        `capability floor (tiered), capability ${cap} at ${lane.costBasis} cost.`
      : `Selected ${lane.id} (${lane.model}) for ${task.category}: ` + `capability ${cap} at ${lane.costBasis} cost.`;

  // Append policy if active and not balanced
  if (routingPolicy !== undefined && routingPolicy !== 'balanced') {
    reason += ` (policy: ${routingPolicy} active)`;
  }

  // Annotate only when evidence actually moved the score (avoid overstating tiny
  // samples): at least one weighted review AND a different rounded value.
  if (f.evidenceN >= 1 && f.capability.toFixed(2) !== f.declared.toFixed(2)) {
    reason += ` (learned: declared ${f.declared.toFixed(2)}, n=${f.evidenceN.toFixed(1)}.)`;
  }
  return reason;
}

/** A lane that passed the structural + policy eligibility filter, with its verdict. */
export interface EligibleLane {
  lane: Lane;
  verdict: PolicyVerdict;
}

/**
 * The lanes that pass the structural pre-gate guard AND the policy verdict for
 * this task — the set routeDecide scores over, WITHOUT the availability filter or
 * scoring. Exposed so a host can probe availability for exactly these lanes (and
 * not waste an I/O probe on a lane that's disabled / gated / policy-blocked and
 * would never be routed to anyway). routeDecide layers availability + scoring on
 * top of this, so the two can never disagree on what's eligible.
 */
/**
 * F — host-aware lane gating (a THIRD-PARTY-terms axis, separate from data
 * trust; deliberately NOT YOLO-overridable):
 *   lane.hosts absent  ⇒ allowed everywhere (back-compat, zero-change)
 *   lane.hosts present ⇒ ctx.host must be present AND listed (FAIL CLOSED —
 *                        unknown identity never bypasses a configured allowlist)
 * Used by every independent lane filter: eligibleLanes, canReassign,
 * selectReviewManager, the adapter's selectManagerLane (host-turn Stop
 * review), and the adapter's reviewer-reservation.
 */
export function hostAllowsLane(lane: Lane, ctx: Pick<RouteContext, 'host'>): boolean {
  if (!lane.hosts || lane.hosts.length === 0) return true;
  return typeof ctx.host === 'string' && ctx.host !== '' && lane.hosts.includes(ctx.host);
}

/**
 * Does a lane's (resolved) model id satisfy a user's per-request model pin?
 * Case-insensitive; exact, or a boundary-aware prefix so a family name pins
 * its concrete resolution ("minimax" ⇒ minimax-m3, "claude-haiku" ⇒
 * claude-haiku-4-5, "gpt-5" ⇒ gpt-5.5) without "gpt" matching everything.
 */
export function modelMatchesPin(laneModel: string, pin: string): boolean {
  const m = laneModel.toLowerCase();
  const p = pin.trim().toLowerCase();
  if (p === '') return false;
  if (m === p) return true;
  return m.startsWith(p) && ['-', '.', ':', '@', '/'].includes(m[p.length] ?? '');
}

export function eligibleLanes(task: Task, ctx: RouteContext, policy: Policy): EligibleLane[] {
  const disabled = new Set(policy.disabledLaneIds ?? []);
  const policyContext = ctx.policyContext ?? {};
  // YOLO forces both safety opt-ins open (the `--dangerously-skip-permissions`
  // analogue); see RouteContext.yolo and the per-lane / per-verdict handling below.
  const yolo = ctx.yolo ?? false;
  const gateReady = yolo ? true : (ctx.gateReady ?? false);
  const readerEgress = yolo ? true : (ctx.readerEgress ?? false);
  // Tandem access gate: a `repo-tight` task needs LIVE repo/tool/shell access, so
  // only a lane that can actually act on the repo survives — the native host or an
  // agentic full lane (see canDoRepoTight). Worker/reader lanes AND full-but-answer-
  // only/remote lanes are filtered out, because they would only receive prompt +
  // attachments and blind-guess. When none qualify, eligibleLanes returns [] and
  // routeDecide throws ⇒ runTask degrades to native (the host does it). Orthogonal to
  // the data-egress policy below — this is about capability/access, not data trust.
  const repoTight = ctx.access_need === 'repo-tight';
  const out: EligibleLane[] = [];
  for (const lane of ctx.lanes) {
    // Order: disabled → host scope → structural gates → access → policy.
    if (disabled.has(lane.id) || !hostAllowsLane(lane, ctx)) continue;
    const elevated = isReaderElevated(lane, ctx.fullAccessLaneIds);
    if (!isSelectablePreGate(lane, gateReady, readerEgress, yolo, elevated)) continue;
    if (repoTight && !canDoRepoTight(lane)) continue;
    const { verdict } = evaluate(task, lane, policyContext, policy, elevated);
    // Normal: drop `block` AND `force-trusted`-on-non-full. YOLO: waive the egress
    // policy (deny-by-default, sensitive/private, reader hard cap — all surface as
    // `force-trusted`, never `block`) but still honor an explicit `block` rule — the
    // ONLY way `evaluate` yields `block` — as a deliberate operator kill-switch, like
    // `disabledLaneIds` and a permission deny-rule under --dangerously-skip-permissions.
    // Elevated readers survive force-trusted unless secretHit is true or blocked.
    const admitted = elevated
      ? verdict !== 'block' && policyContext.secretHit !== true
      : laneAllowedByVerdict(lane, verdict);
    // An elevated reader never takes a secret context, even under YOLO.
    if (elevated && policyContext.secretHit === true) continue;
    if (yolo ? verdict === 'block' : !admitted) continue;
    out.push({ lane, verdict });
  }
  return out;
}

/**
 * Decide which lane should handle a task. Pure: depends only on its arguments.
 *
 * @throws if there are no candidate lanes after applying the policy.
 */
export function routeDecide(
  task: Task,
  ctx: RouteContext,
  policy: Policy,
): RouteDecision {
  // Availability filter (optional): when the host supplies the runnable-lane set,
  // a non-native lane that isn't in it (CLI not installed, local server down, key
  // missing) is excluded so it can never win on cost. Absent ⇒ not checked.
  const available = ctx.availableLaneIds ? new Set(ctx.availableLaneIds) : null;

  // Start from the gate+policy-eligible lanes, then drop unavailable ones (native
  // is always runnable and exempt). Remember each survivor's verdict.
  const verdicts = new Map<string, PolicyVerdict>();
  const candidates = eligibleLanes(task, ctx, policy)
    .filter(({ lane }) => !(available && !lane.native && !available.has(lane.id)))
    .map(({ lane, verdict }) => {
      verdicts.set(lane.id, verdict);
      return lane;
    });

  if (candidates.length === 0) {
    throw new Error(
      'routeDecide: no candidate lanes available (lanes empty, disabled, excluded ' +
        'before the gate, unavailable to run, or blocked/forced-trusted away by policy).',
    );
  }

  // Task-aware opts: context-level (rankings prior) + the difficulty cell when
  // the task carries a bucket and the learned difficulty overlay is present.
  const effectiveOpts = effectiveOptsForTask(ctx, task);
  // Legacy strategy parameter is treated as an input alias.
  // routingPolicy takes precedence over strategy if both are provided.
  const routingPolicy = ctx.routingPolicy ?? (ctx.strategy === 'tiered' ? 'cheapest' : 'balanced');
  const scored = candidates.map((lane) =>
    scoreLane(lane, task, ctx.capHeadroom, ctx.observedCapability, ctx.observedCapabilityByModel, effectiveOpts, ctx.healthPenalty, ctx.laneCost, routingPolicy),
  );
  const tiered = routingPolicy === 'cheapest';
  // `maximize` (default): most capable wins. `tiered`: cheapest lane clearing the
  // capability floor wins ("start cheap"); falls back to maximize if none clear it.
  const scores = tiered ? orderTiered(scored, candidates, task, ctx) : [...scored].sort(compareScores);

  // PREFERENCE (universal, opt-in): honor an explicit `preferLaneId` — ANY configured
  // lane id (any vendor, CLI or API) — when it is an eligible+available candidate and
  // is NOT a hard opt-out (effective capability > 0 for the category). It is moved to
  // the front of `scores` so the winner-is-scores[0] invariant holds; the hard rails
  // (gate, policy, sensitivity/repo_class, availability) still gate candidacy, so a
  // preference can never bypass them — an ineligible/unknown preferred lane simply
  // falls back to the normal ranking. Capability-0 opt-outs are never honored.
  let preferred = false;
  if (ctx.preferLaneId != null) {
    const idx = scores.findIndex((s) => s.laneId === ctx.preferLaneId && s.factors.capability > 0);
    if (idx >= 0) {
      const picked = scores.splice(idx, 1)[0]!;
      scores.unshift(picked);
      preferred = true;
    }
  }

  const winner = scores[0]!;
  const winningLane = candidates.find((lane) => lane.id === winner.laneId)!;
  // Only claim "tiered" in the reason when the winner ACTUALLY cleared the floor — a
  // no-clear fallback used the maximize ranking, so it must not say "clearing the floor".
  const wonByTier =
    !preferred && tiered && winner.factors.capability > 0 && winner.factors.capability >= tierFloorFor(task, ctx);

  return {
    laneId: winner.laneId,
    reason: describe(winningLane, winner, task, ctx.routingPolicy, wonByTier, preferred),
    scores,
    policyVerdict: verdicts.get(winner.laneId)!,
  };
}

/** The effective-capability floor for `task` under the tiered strategy. */
function tierFloorFor(task: Task, ctx: RouteContext): number {
  return ctx.tierFloorByCategory?.[task.category] ?? ctx.tierFloor ?? DEFAULT_TIER_FLOOR;
}

/** Default minimum effective capability a lane must clear to be a tiered candidate. */
export const DEFAULT_TIER_FLOOR = 0.6;

/**
 * Tiered ordering ("start cheap, step up"): among lanes clearing the per-category
 * capability floor, rank by cap-health (least cap-constrained first), then cost
 * (laneCost, else costBasis penalty), then LOWEST effective capability (the smallest
 * model that clears the floor), then id. If NO lane clears the floor, fall back to the
 * maximize ordering so routing never fails. Floor-clearers always precede the rest.
 */
function orderTiered(scored: LaneScore[], candidates: readonly Lane[], task: Task, ctx: RouteContext): LaneScore[] {
  const floor = tierFloorFor(task, ctx);
  const laneById = new Map(candidates.map((l) => [l.id, l]));
  const costOf = (id: string): number => ctx.laneCost?.[id] ?? COST_PENALTY[laneById.get(id)!.costBasis];
  // A capability-0 lane is a hard opt-out — never a floor-clearer, even if a
  // misconfigured floor is ≤ 0. It falls into `rest` (and stays in `scores`), demoted
  // by compareScores. `rest` is the exact complement of `clears` so nothing is dropped.
  const isClear = (s: LaneScore): boolean => s.factors.capability > 0 && s.factors.capability >= floor;
  const clears = scored.filter(isClear);
  if (clears.length === 0) return [...scored].sort(compareScores); // none clear ⇒ maximize
  const byTier = (a: LaneScore, b: LaneScore): number => {
    const depriRawA = a.factors.capPenalty + (a.factors.healthPenalty ?? 0);
    const depriA = Number.isFinite(depriRawA) ? depriRawA : 0;
    const depriRawB = b.factors.capPenalty + (b.factors.healthPenalty ?? 0);
    const depriB = Number.isFinite(depriRawB) ? depriRawB : 0;
    if (depriA !== depriB) return depriA - depriB; // combined cap + health deprioritization
    const ca = costOf(a.laneId);
    const cb = costOf(b.laneId);
    if (ca !== cb) return ca - cb; // cheaper first
    if (a.factors.capability !== b.factors.capability) return a.factors.capability - b.factors.capability; // smallest over floor
    return a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0;
  };
  const rest = scored.filter((s) => !isClear(s)).sort(compareScores);
  return [...clears.sort(byTier), ...rest];
}
