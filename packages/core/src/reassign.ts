/**
 * Assignment / reassignment (C-8). Pure decision logic the manager uses to
 * escalate a routed task whose output was rated `needs-rework`/`fail`.
 *
 * Trust-ladder rule (up-only): `blocked < worker < reader < full`. A
 * reassignment may only move UP the ladder (never hand more context, or fewer
 * controls, to a less-trusted lane) and must re-pass the policy gate for the new
 * lane. `blocked` is never a target; `reader` becomes a target once its boundary +
 * executor land (F-2). A loop-guard caps the number of reassignments. Authority
 * applies only within router-managed tasks.
 */

import { evaluate, laneAllowedByVerdict } from './policy.ts';
import { effectiveCapabilityFor, isSelectablePreGate } from './route.ts';
import type { ReviewVerdict } from './ledger.ts';
import type { Lane, Policy, RouteContext, Task, TrustMode } from './types.ts';

/** Strict trust ordering for the ladder: blocked < worker < reader < full. */
export const TRUST_RANK: Record<TrustMode, number> = {
  blocked: 0,
  worker: 1,
  reader: 2,
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
  // Never escalate/reassign to a lane that can't run now (same availability filter
  // as routing; native is always runnable). Absent set ⇒ availability not checked.
  if (ctx.availableLaneIds && !to.native && !new Set(ctx.availableLaneIds).has(to.id)) return false;
  // Fail CLOSED on an unrankable trust mode (e.g. a deprecated `monitored` reaching
  // a direct JS caller without config normalization): `undefined` comparisons are
  // always false, which would silently bypass the down-ladder guard.
  const fromRank = TRUST_RANK[from.trust_mode] as number | undefined;
  const toRank = TRUST_RANK[to.trust_mode] as number | undefined;
  if (fromRank === undefined || toRank === undefined) return false;
  if (toRank < fromRank) return false; // never move down
  // Same structural gate as routing (worker needs gate+cert; reader needs the
  // egress opt-in + cert + attestation; blocked never; pre-gate API excluded).
  if (!isSelectablePreGate(to, ctx.gateReady ?? false, ctx.readerEgress ?? false)) return false;
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

  // Use EFFECTIVE capability so an empirically-degrading lane isn't preferred.
  const cap = (l: Lane) => effectiveCapabilityFor(l, task.category, ctx.observedCapability);
  const fromRank = TRUST_RANK[from.trust_mode];
  const fromCap = cap(from);
  const eligible = candidates.filter((c) => {
    if (!canReassign(from, c, task, ctx, policy)) return false;
    // An improvement: a stronger trust tier, or the same tier but more capable.
    return TRUST_RANK[c.trust_mode] > fromRank || cap(c) > fromCap;
  });
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    const byRank = TRUST_RANK[b.trust_mode] - TRUST_RANK[a.trust_mode];
    if (byRank !== 0) return byRank;
    const byCap = cap(b) - cap(a);
    if (byCap !== 0) return byCap;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return eligible[0]!;
}

// ---------------------------------------------------------------------------
// C-13: quality-driven escalation (pure primitives). The orchestrator
// (runWithEscalation) composes review() + these; the adapter only wires it.
// ---------------------------------------------------------------------------

/** The structural next move after a manager review of an offloaded subtask. */
export type EscalationAction = 'accept' | 'rework' | 'escalate' | 'give_back';

/** How many extra legs have already run this offload. */
export interface EscalationCounters {
  /** Same-lane reworks already done (pre-escalation only). */
  reworks: number;
  /** Escalations already done. */
  escalations: number;
}

/** Loop-guard caps for {@link escalationDecision}. */
export interface EscalationCaps {
  /** Max same-lane reworks (default 1). */
  maxReworks?: number;
  /** Max escalations (default 1). */
  maxEscalations?: number;
}

/**
 * Decide the STRUCTURAL action from a review verdict + counters — pure, no lane
 * or note inspection. `pass` ⇒ accept; initial `needs-rework` ⇒ one same-lane
 * `rework` (pre-escalation only); `fail` (or `needs-rework` after the rework
 * budget) ⇒ `escalate` while the escalation budget remains; once escalated, any
 * non-`pass` ⇒ `give_back`. The orchestrator may further DOWNGRADE the result
 * (rework→escalate→give_back) when lane constraints don't allow it (e.g. a
 * metered subject can't be reworked, or no escalation target qualifies).
 */
export function escalationDecision(
  verdict: ReviewVerdict,
  counters: EscalationCounters,
  caps: EscalationCaps = {},
): EscalationAction {
  const maxReworks = caps.maxReworks ?? 1;
  const maxEscalations = caps.maxEscalations ?? 1;
  if (verdict === 'pass') return 'accept';
  // A same-lane rework is allowed only before any escalation, within budget.
  if (verdict === 'needs-rework' && counters.escalations === 0 && counters.reworks < maxReworks) {
    return 'rework';
  }
  // fail, or needs-rework past the rework budget ⇒ escalate while budget remains;
  // once the escalation budget is spent, hand back (no silent acceptance).
  if (counters.escalations < maxEscalations) return 'escalate';
  return 'give_back';
}

/** Options for {@link selectEscalationTarget}. */
export interface EscalationTargetOptions {
  /** Required capability improvement over the subject (default 0.15; clamped ≥0). */
  minDelta?: number;
  /** Lane ids never eligible as a target — always includes the active manager. */
  excludeIds?: readonly string[];
}

/**
 * Choose the QUALITY escalation target: the **most capable** allowed lane that is
 * a genuine capability improvement. Unlike {@link reassignmentTarget} (trust-first,
 * for C-8), this is capability-first — a quality ladder, not trust remediation.
 * A candidate must: pass {@link canReassign} (never down the trust ladder + gate +
 * policy + not the subject), be **non-native** (the host is a terminal give-back,
 * not an executed leg), be **marginal-free** (`subscription`/`local` — v1 adds no
 * metered $), have `capability ≥ subject + minDelta` for the category, and not be
 * in `excludeIds` (the active manager — preserves review independence). Returns the
 * most capable (tie-break: higher trust, then id), or `null` ⇒ caller gives back.
 */
export function selectEscalationTarget(
  subject: Lane,
  candidates: readonly Lane[],
  task: Task,
  ctx: RouteContext,
  policy: Policy,
  opts: EscalationTargetOptions = {},
): Lane | null {
  const minDelta = Math.max(0, opts.minDelta ?? 0.15);
  const exclude = new Set(opts.excludeIds ?? []);
  // Use EFFECTIVE capability: don't escalate to an empirically-failing lane.
  const cap = (l: Lane) => effectiveCapabilityFor(l, task.category, ctx.observedCapability);
  const fromCap = cap(subject);
  const eligible = candidates.filter(
    (c) =>
      !exclude.has(c.id) &&
      !c.native &&
      (c.costBasis === 'subscription' || c.costBasis === 'local') &&
      canReassign(subject, c, task, ctx, policy) &&
      cap(c) >= fromCap + minDelta,
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const byCap = cap(b) - cap(a);
    if (byCap !== 0) return byCap;
    // MODEL-TIERS: prefer stepping UP the SAME family — a TIE-BREAK only (after
    // capability), so we never pass over a clearly stronger lane for a same-family one.
    if (subject.model_family !== undefined) {
      const aSame = a.model_family === subject.model_family ? 0 : 1;
      const bSame = b.model_family === subject.model_family ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
    }
    const byRank = TRUST_RANK[b.trust_mode] - TRUST_RANK[a.trust_mode];
    if (byRank !== 0) return byRank;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return eligible[0]!;
}
