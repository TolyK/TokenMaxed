/**
 * The routing brain: pure, deterministic, no I/O.
 *
 * `routeDecide` picks the cheapest capable lane for a task. In v0 the rule is
 * deliberately simple and explainable: score each candidate by its capability
 * for the task's category, minus a penalty for its marginal cost basis, then
 * take the highest score. Ties break deterministically by lane id so the same
 * inputs always yield the same decision.
 *
 * Richer category rules, capability floors, and health/cap gating arrive in
 * later steps (P1-S5, P1-S12); the policy gate (P1-S9) filters candidates
 * before scoring once untrusted lanes exist. The shape returned here is stable.
 */

import { isExecutorCertified } from './boundary.ts';
import { evaluate, laneAllowedByVerdict } from './policy.ts';
import { TRUSTED_PROVENANCES } from './types.ts';
import type {
  ExecutionMode,
  Lane,
  LaneScore,
  ObservedCapability,
  ObservedCapabilityByLane,
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
 * Enforcement order is law. A non-`full` lane (worker/monitored/blocked) may run
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
 */
export function isSelectablePreGate(lane: Lane, gateReady = false): boolean {
  if (lane.trust_mode === 'blocked') return false; // never selectable, period
  // `monitored` is deferred (later phase) — no monitoring implementation yet.
  if (lane.trust_mode === 'monitored') return false;
  // Untrusted `worker` lanes are admitted only when the gate is ready AND a
  // core-owned, egress-CI-certified executor exists for the lane. The policy gate
  // and the minimizer then apply on top (defense in depth) before anything sends.
  if (lane.trust_mode === 'worker') return gateReady && isExecutorCertified(lane);
  // Full (trusted, user-approved) lanes: CLI/local always selectable; an API lane
  // only once the gate is ready (the blanket pre-gate "no API lane" guard relaxes).
  return gateReady || lane.kind !== 'api';
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

/** Options for {@link effectiveCapability}. */
export interface EffectiveCapabilityOptions {
  /**
   * Shrinkage prior strength (pseudo-count). Higher ⇒ more evidence required to
   * move away from the declared prior. Must be finite and > 0; otherwise
   * {@link DEFAULT_PRIOR_STRENGTH} is used.
   */
  priorStrength?: number;
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
  const declared = declaredCapabilityFor(lane, category);
  return effectiveCapability(declared, overlay?.[lane.id]?.[category], opts);
}

function scoreLane(
  lane: Lane,
  task: Task,
  capHeadroom?: Record<string, number>,
  observedCapability?: ObservedCapabilityByLane,
): LaneScore {
  const declared = declaredCapabilityFor(lane, task.category);
  const observed = observedCapability?.[lane.id]?.[task.category];
  const capability = effectiveCapability(declared, observed);
  const costPenalty = COST_PENALTY[lane.costBasis];
  const capPenalty = capPenaltyFor(capHeadroom?.[lane.id]);
  const score = WEIGHTS.capability * capability - WEIGHTS.cost * costPenalty - capPenalty;
  return {
    laneId: lane.id,
    score,
    factors: { capability, costPenalty, capPenalty, declared, evidenceN: observed?.n ?? 0 },
  };
}

/**
 * Order scores best-first with a fully deterministic tie-break:
 * higher score wins; on equal score, the lower lane id (ascending) wins.
 */
function compareScores(a: LaneScore, b: LaneScore): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0;
}

function describe(lane: Lane, best: LaneScore, task: Task): string {
  const f = best.factors;
  const cap = f.capability.toFixed(2);
  let reason =
    `Selected ${lane.id} (${lane.model}) for ${task.category}: ` +
    `capability ${cap} at ${lane.costBasis} cost.`;
  // Annotate only when evidence actually moved the score (avoid overstating tiny
  // samples): at least one weighted review AND a different rounded value.
  if (f.evidenceN >= 1 && f.capability.toFixed(2) !== f.declared.toFixed(2)) {
    reason += ` (learned: declared ${f.declared.toFixed(2)}, n=${f.evidenceN.toFixed(1)}.)`;
  }
  return reason;
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
  const disabled = new Set(policy.disabledLaneIds ?? []);
  const policyContext = ctx.policyContext ?? {};
  const gateReady = ctx.gateReady ?? false;

  // Filter candidates by the structural pre-gate guard AND the policy verdict,
  // before scoring. Remember each survivor's verdict for the decision.
  const verdicts = new Map<string, PolicyVerdict>();
  const candidates = ctx.lanes.filter((lane) => {
    if (disabled.has(lane.id) || !isSelectablePreGate(lane, gateReady)) return false;
    const { verdict } = evaluate(task, lane, policyContext, policy);
    if (!laneAllowedByVerdict(lane, verdict)) return false;
    verdicts.set(lane.id, verdict);
    return true;
  });

  if (candidates.length === 0) {
    throw new Error(
      'routeDecide: no candidate lanes available (lanes empty, disabled, excluded ' +
        'before the gate, or blocked/forced-trusted away by policy).',
    );
  }

  const scores = candidates
    .map((lane) => scoreLane(lane, task, ctx.capHeadroom, ctx.observedCapability))
    .sort(compareScores);
  const winner = scores[0]!;
  const winningLane = candidates.find((lane) => lane.id === winner.laneId)!;

  return {
    laneId: winner.laneId,
    reason: describe(winningLane, winner, task),
    scores,
    policyVerdict: verdicts.get(winner.laneId)!,
  };
}
