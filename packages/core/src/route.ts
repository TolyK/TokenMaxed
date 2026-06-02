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

import { TRUSTED_PROVENANCES } from './types.ts';
import type {
  ExecutionMode,
  Lane,
  LaneScore,
  Policy,
  RouteContext,
  RouteDecision,
  Task,
} from './types.ts';

/** Capability assumed for a lane that declares no score for a category. */
export const DEFAULT_CAPABILITY = 0.5;

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
  // Untrusted `worker` lanes require BOTH the policy gate (minimization) AND
  // per-executor egress certification — neither exists yet — so they are never
  // admitted by this structural guard, regardless of `gateReady`. Their
  // admission is added by the policy-engine + certification steps, layered on top.
  if (lane.trust_mode === 'worker') return false;
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

/** The lane's capability for a task category, defaulting when unspecified. */
export function capabilityFor(lane: Lane, category: Task['category']): number {
  const declared = lane.capability?.[category];
  return clamp01(declared ?? DEFAULT_CAPABILITY);
}

function scoreLane(lane: Lane, task: Task, capHeadroom?: Record<string, number>): LaneScore {
  const capability = capabilityFor(lane, task.category);
  const costPenalty = COST_PENALTY[lane.costBasis];
  const capPenalty = capPenaltyFor(capHeadroom?.[lane.id]);
  const score = WEIGHTS.capability * capability - WEIGHTS.cost * costPenalty - capPenalty;
  return { laneId: lane.id, score, factors: { capability, costPenalty, capPenalty } };
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
  const cap = best.factors.capability.toFixed(2);
  return (
    `Selected ${lane.id} (${lane.model}) for ${task.category}: ` +
    `capability ${cap} at ${lane.costBasis} cost.`
  );
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
  const candidates = ctx.lanes.filter(
    (lane) => !disabled.has(lane.id) && isSelectablePreGate(lane, ctx.gateReady ?? false),
  );

  if (candidates.length === 0) {
    throw new Error(
      'routeDecide: no candidate lanes available (lanes empty, disabled by policy, ' +
        'or excluded as untrusted/API before the minimization gate exists).',
    );
  }

  const scores = candidates
    .map((lane) => scoreLane(lane, task, ctx.capHeadroom))
    .sort(compareScores);
  const winner = scores[0]!;
  const winningLane = candidates.find((lane) => lane.id === winner.laneId)!;

  return {
    laneId: winner.laneId,
    reason: describe(winningLane, winner, task),
    scores,
  };
}
