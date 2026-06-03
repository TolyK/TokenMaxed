/**
 * F-1 capability feedback — the aggregation half of the loop. Pure and
 * clock-free: it turns the ledger's content-free manager-review verdicts into an
 * {@link ObservedCapabilityByLane} overlay that {@link effectiveCapabilityFor}
 * blends with the declared config prior.
 *
 * The signal is deliberately conservative (see the filters below) so routing
 * only learns from genuine, attributable, reviewer-cast outcomes:
 *  - recency-decayed (recent verdicts dominate stale ones — model rankings churn);
 *  - de-duplicated per attempt (a re-reviewed attempt can't be double-counted);
 *  - attributed to the lane that produced the work (`subject_lane_id`).
 *
 * Caveat (documented, not a bug): review success is an *empirical adjustment*,
 * not a true model-quality estimator — it's confounded by task difficulty,
 * reviewer strictness, and prompt quality. And lanes that win routing accrue
 * more samples while losers stop getting fresh evidence; shrinkage toward the
 * declared prior dampens but does not eliminate that bias. This is an opt-in
 * heuristic, not unbiased exploration.
 */

import type {
  LedgerEvent,
  OutcomeEvent,
  ReviewVerdict,
} from './ledger.ts';
import type {
  ObservedCapability,
  ObservedCapabilityByLane,
  TaskCategory,
} from './types.ts';

const MS_PER_DAY = 86_400_000;

/** NUL — a separator that cannot collide with any id/category content. */
const SEP = '\u0000';

/** Default half-life (days) for recency decay; code constant in v1 (not config). */
export const DEFAULT_HALF_LIFE_DAYS = 30;

/** Per-event contribution on the dogfood success scale: pass=1, needs-rework=½, fail=0. */
function verdictValue(verdict: ReviewVerdict): number {
  if (verdict === 'pass') return 1;
  if (verdict === 'needs-rework') return 0.5;
  return 0;
}

/** Options for {@link outcomeCapability}. */
export interface OutcomeCapabilityOptions {
  /**
   * Recency half-life in days: an outcome `halfLifeDays` old counts half as much
   * as a fresh one. Must be finite and > 0; otherwise {@link DEFAULT_HALF_LIFE_DAYS}.
   */
  halfLifeDays?: number;
}

/**
 * Whether an event is a learnable, attributable, reviewer-cast router-task
 * outcome. Excludes host-turn / unattributed subjects (we only learn about
 * offload lanes) and user votes (they don't steer routing in v1).
 */
function isLearnableOutcome(e: LedgerEvent): e is OutcomeEvent {
  return (
    e.event_type === 'outcome' &&
    e.subject_type === 'router_task' &&
    e.voter === 'reviewer_model' &&
    typeof e.subject_lane_id === 'string' &&
    e.subject_lane_id !== '' &&
    typeof e.task_id === 'string' &&
    e.task_id !== ''
  );
}

/** Stable de-dup key: one outcome per attempt of a (lane, category) task. */
function dedupKey(e: OutcomeEvent): string {
  return [e.task_id, e.attempt, e.subject_lane_id, e.category].join(SEP);
}

interface Accumulator {
  laneId: string;
  category: TaskCategory;
  weightSum: number;
  weightedValueSum: number;
}

/**
 * Build the observed-capability overlay from ledger events as of `now`.
 *
 * @param events the ledger (any mix; only learnable outcomes are used).
 * @param now    current time in epoch ms (injected — core stays clock-free).
 *               Outcomes timestamped after `now` are treated as age 0 (weight ≤ 1),
 *               never negative age.
 * @returns a sparse `{ [laneId]: { [category]: { rate, n } } }`; only lane×category
 *   pairs with real (decayed) evidence appear. Deterministic for the same inputs.
 */
export function outcomeCapability(
  events: readonly LedgerEvent[],
  now: number,
  opts: OutcomeCapabilityOptions = {},
): ObservedCapabilityByLane {
  const halfLife =
    Number.isFinite(opts.halfLifeDays) && (opts.halfLifeDays as number) > 0
      ? (opts.halfLifeDays as number)
      : DEFAULT_HALF_LIFE_DAYS;
  const nowMs = Number.isFinite(now) ? now : Number.NaN;

  // De-dup: keep the latest outcome (max seq) per (task,attempt,lane,category).
  const latest = new Map<string, OutcomeEvent>();
  for (const e of events) {
    if (!isLearnableOutcome(e)) continue;
    if (!Number.isFinite(Date.parse(e.ts))) continue;
    const key = dedupKey(e);
    const prev = latest.get(key);
    if (!prev || e.seq > prev.seq) latest.set(key, e);
  }

  // Accumulate decay-weighted verdicts per lane×category.
  const acc = new Map<string, Accumulator>();
  for (const e of latest.values()) {
    const tsMs = Date.parse(e.ts);
    const ageDays = Number.isFinite(nowMs) ? Math.max(0, (nowMs - tsMs) / MS_PER_DAY) : 0;
    const weight = Math.pow(0.5, ageDays / halfLife);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const laneId = e.subject_lane_id as string;
    const accKey = [laneId, e.category].join(SEP);
    let a = acc.get(accKey);
    if (!a) {
      a = { laneId, category: e.category, weightSum: 0, weightedValueSum: 0 };
      acc.set(accKey, a);
    }
    a.weightSum += weight;
    a.weightedValueSum += weight * verdictValue(e.verdict);
  }

  // Emit the sparse overlay.
  const overlay: ObservedCapabilityByLane = Object.create(null);
  for (const a of acc.values()) {
    if (!(a.weightSum > 0) || !Number.isFinite(a.weightSum)) continue;
    const observed: ObservedCapability = { rate: a.weightedValueSum / a.weightSum, n: a.weightSum };
    const inner = overlay[a.laneId] ?? (overlay[a.laneId] = Object.create(null));
    inner[a.category] = observed;
  }
  return overlay;
}
