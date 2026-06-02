/**
 * Assignment / reassignment (C-8). Pure decision logic the manager uses to
 * escalate a routed task whose output was rated `needs-rework`/`fail`.
 *
 * Trust-ladder rule (up-only): `blocked < worker < monitored < full`. A
 * reassignment may only move UP the ladder (never hand more context, or fewer
 * controls, to a less-trusted lane) and must re-pass the policy gate for the new
 * lane. `monitored`/`blocked` are never reassignment targets in v0 (monitored is
 * deferred). A loop-guard caps the number of reassignments. Authority applies
 * only within router-managed tasks.
 */

import { evaluate, laneAllowedByVerdict } from './policy.ts';
import { capabilityFor, isSelectablePreGate } from './route.ts';
import type { ReviewVerdict } from './ledger.ts';
import type { Lane, Policy, RouteContext, Task, TrustMode } from './types.ts';

/** Strict trust ordering for the ladder. */
export const TRUST_RANK: Record<TrustMode, number> = {
  blocked: 0,
  worker: 1,
  monitored: 2,
  full: 3,
};

/** Whether a review verdict warrants reassignment. */
export function shouldReassign(verdict: ReviewVerdict): boolean {
  return verdict === 'needs-rework' || verdict === 'fail';
}

/**
 * Whether work may be reassigned from `from` to `to`. The security invariant is
 * **never move DOWN the trust ladder** (never hand more context, or fewer
 * controls, to a less-trusted lane). Same-tier reassignment IS allowed and is the
 * primary case — e.g. escalating a failed task from one trusted (`full`) model to
 * a stronger trusted model. Also requires: a different, non-disabled lane that
 * passes the same structural gate as routing and the policy gate for this task.
 */
export function canReassign(from: Lane, to: Lane, task: Task, ctx: RouteContext, policy: Policy): boolean {
  if (to.id === from.id) return false;
  if ((policy.disabledLaneIds ?? []).includes(to.id)) return false; // admin-disabled never selectable
  if (TRUST_RANK[to.trust_mode] < TRUST_RANK[from.trust_mode]) return false; // never move down
  // Same structural gate as routing (also excludes blocked/monitored, ungated workers, pre-gate API).
  if (!isSelectablePreGate(to, ctx.gateReady ?? false)) return false;
  const { verdict } = evaluate(task, to, ctx.policyContext ?? {}, policy);
  return laneAllowedByVerdict(to, verdict);
}

/** Options for {@link reassignmentTarget}. */
export interface ReassignOptions {
  /** How many reassignments have already happened this task (default 0). */
  attempts?: number;
  /** Maximum reassignments allowed (loop-guard; default 2). */
  maxReassignments?: number;
}

/**
 * Choose the lane to escalate to on a needs-rework/fail: the strongest, then
 * most-capable, candidate that {@link canReassign} permits AND is an actual
 * improvement — either a higher trust tier OR a more capable lane at the same
 * tier (so we don't reassign laterally to an equal/worse lane). Returns `null`
 * if the loop-guard is hit or no better lane is allowed (caller keeps the
 * current result or degrades to native).
 */
export function reassignmentTarget(
  from: Lane,
  candidates: readonly Lane[],
  task: Task,
  ctx: RouteContext,
  policy: Policy,
  opts: ReassignOptions = {},
): Lane | null {
  const attempts = opts.attempts ?? 0;
  const max = opts.maxReassignments ?? 2;
  if (attempts >= max) return null;

  const fromRank = TRUST_RANK[from.trust_mode];
  const fromCap = capabilityFor(from, task.category);
  const eligible = candidates.filter((c) => {
    if (!canReassign(from, c, task, ctx, policy)) return false;
    // An improvement: a stronger trust tier, or the same tier but more capable.
    return TRUST_RANK[c.trust_mode] > fromRank || capabilityFor(c, task.category) > fromCap;
  });
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    const byRank = TRUST_RANK[b.trust_mode] - TRUST_RANK[a.trust_mode];
    if (byRank !== 0) return byRank;
    const byCap = capabilityFor(b, task.category) - capabilityFor(a, task.category);
    if (byCap !== 0) return byCap;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return eligible[0]!;
}
