/**
 * F-1 capability feedback — the aggregation half of the loop. Pure and
 * clock-free: it turns the ledger's content-free manager-review verdicts and
 * direct user feedback outcomes into an {@link ObservedCapabilityByModel}
 * overlay that {@link effectiveCapabilityFor} blends with the declared config prior.
 *
 * The signal is deliberately conservative (see the filters below) so routing
 * only learns from genuine, attributable, reviewer-cast or user-cast outcomes:
 *  - recency-decayed (recent verdicts dominate stale ones — model rankings churn);
 *  - de-duplicated per attempt (a re-reviewed attempt can't be double-counted);
 *  - attributed to the resolved model that produced the work (`subject_model_resolved`
 *    or `subject_model`; outcomes without either are excluded — treat-as-unknown).
 *
 * Caveat (documented, not a bug): review success is an *empirical adjustment*,
 * not a true model-quality estimator — it's confounded by task difficulty,
 * reviewer strictness, and prompt quality. And lanes/models that win routing
 * accrue more samples while losers stop getting fresh evidence; shrinkage toward
 * the declared prior dampens but does not eliminate that bias. This is an opt-in
 * heuristic, not unbiased exploration.
 */

import type {
  LedgerEvent,
  OutcomeEvent,
  ReviewVerdict,
} from './ledger.ts';
import type {
  DifficultyBucket,
  ObservedCapability,
  ObservedCapabilityByModel,
  ObservedCapabilityByModelDifficulty,
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
 * Whether an event is a learnable, attributable router-task outcome.
 * Excludes host-turn / unattributed subjects (we only learn about
 * offload lanes). Allows reviewer models and direct user feedback.
 */
function isLearnableOutcome(e: LedgerEvent): e is OutcomeEvent {
  return (
    e.event_type === 'outcome' &&
    e.subject_type === 'router_task' &&
    (e.voter === 'reviewer_model' || e.voter === 'user') &&
    typeof e.subject_lane_id === 'string' &&
    e.subject_lane_id !== '' &&
    typeof e.task_id === 'string' &&
    e.task_id !== ''
  );
}

/** Canonical model key for learning: resolved id preferred, else raw subject_model. */
function modelKeyFromOutcome(e: OutcomeEvent): string | undefined {
  const resolved = e.subject_model_resolved?.trim();
  if (resolved) return resolved;
  const raw = e.subject_model?.trim();
  if (raw) return raw;
  return undefined;
}

/** Stable de-dup key: one outcome per attempt of a (model, category) task. */
function dedupKey(e: OutcomeEvent): string {
  return [e.task_id, e.attempt, modelKeyFromOutcome(e)!, e.category].join(SEP);
}

interface Accumulator {
  modelKey: string;
  category: TaskCategory;
  weightSum: number;
  weightedValueSum: number;
}

/**
 * Returns the exact list of OutcomeEvents that actually contribute to the capability overlays
 * (survived learnability filters, de-duplication, and decay weight > 0 check).
 */
export function contributingOutcomes(
  events: readonly LedgerEvent[],
  now: number,
  opts: OutcomeCapabilityOptions = {},
): OutcomeEvent[] {
  const halfLife =
    Number.isFinite(opts.halfLifeDays) && (opts.halfLifeDays as number) > 0
      ? (opts.halfLifeDays as number)
      : DEFAULT_HALF_LIFE_DAYS;
  const nowMs = Number.isFinite(now) ? now : Number.NaN;

  // De-dup: keep the latest outcome (max seq) per (task,attempt,model,category).
  const latest = new Map<string, OutcomeEvent>();
  for (const e of events) {
    if (!isLearnableOutcome(e)) continue;
    const modelKey = modelKeyFromOutcome(e);
    if (!modelKey) continue; // treat-as-unknown: legacy/host-turn without model
    if (!Number.isFinite(Date.parse(e.ts))) continue;
    const key = dedupKey(e);
    const prev = latest.get(key);
    if (!prev || e.seq > prev.seq) latest.set(key, e);
  }

  // Filter out zero-weight outcomes
  const result: OutcomeEvent[] = [];
  for (const e of latest.values()) {
    const tsMs = Date.parse(e.ts);
    const ageDays = Number.isFinite(nowMs) ? Math.max(0, (nowMs - tsMs) / MS_PER_DAY) : 0;
    const weight = Math.pow(0.5, ageDays / halfLife);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    result.push(e);
  }
  return result;
}

/**
 * Build the model-keyed observed-capability overlay from ledger events as of `now`.
 *
 * @param events the ledger (any mix; only learnable outcomes with a recorded model are used).
 * @param now    current time in epoch ms (injected — core stays clock-free).
 *               Outcomes timestamped after `now` are treated as age 0 (weight ≤ 1),
 *               never negative age.
 * @returns a sparse `{ [modelKey]: { [category]: { rate, n } } }`; only model×category
 *   pairs with real (decayed) evidence appear. Deterministic for the same inputs.
 */
export function outcomeCapability(
  events: readonly LedgerEvent[],
  now: number,
  opts: OutcomeCapabilityOptions = {},
): ObservedCapabilityByModel {
  const contribs = contributingOutcomes(events, now, opts);
  const halfLife =
    Number.isFinite(opts.halfLifeDays) && (opts.halfLifeDays as number) > 0
      ? (opts.halfLifeDays as number)
      : DEFAULT_HALF_LIFE_DAYS;
  const nowMs = Number.isFinite(now) ? now : Number.NaN;

  // Accumulate decay-weighted verdicts per model×category.
  const acc = new Map<string, Accumulator>();
  for (const e of contribs) {
    const tsMs = Date.parse(e.ts);
    const ageDays = Number.isFinite(nowMs) ? Math.max(0, (nowMs - tsMs) / MS_PER_DAY) : 0;
    const weight = Math.pow(0.5, ageDays / halfLife);

    const modelKey = modelKeyFromOutcome(e)!;
    const accKey = [modelKey, e.category].join(SEP);
    let a = acc.get(accKey);
    if (!a) {
      a = { modelKey, category: e.category, weightSum: 0, weightedValueSum: 0 };
      acc.set(accKey, a);
    }
    a.weightSum += weight;
    a.weightedValueSum += weight * verdictValue(e.verdict);
  }

  // Emit the sparse overlay.
  const overlay: ObservedCapabilityByModel = Object.create(null);
  for (const a of acc.values()) {
    if (!(a.weightSum > 0) || !Number.isFinite(a.weightSum)) continue;
    const observed: ObservedCapability = { rate: a.weightedValueSum / a.weightSum, n: a.weightSum };
    const inner = overlay[a.modelKey] ?? (overlay[a.modelKey] = Object.create(null));
    inner[a.category] = observed;
  }
  return overlay;
}

/**
 * The difficulty-conditioned view of {@link outcomeCapability} (P6 §4): the same
 * learnability filter, de-dup (latest per task/attempt/model/category — an
 * attempt's difficulty rides its winning outcome), and recency decay, but
 * accumulated into model×category×difficulty cells. Outcomes recorded WITHOUT a
 * difficulty are excluded here (treat-as-unknown — they still feed the
 * category-level overlay), so a cell only ever contains evidence that was
 * actually bucketed. Same caveat as the module banner: the bucket is
 * escalation-depth under the active reviewer, a proxy — not ground truth.
 */
export function outcomeCapabilityByDifficulty(
  events: readonly LedgerEvent[],
  now: number,
  opts: OutcomeCapabilityOptions = {},
): ObservedCapabilityByModelDifficulty {
  const contribs = contributingOutcomes(events, now, opts);
  const halfLife =
    Number.isFinite(opts.halfLifeDays) && (opts.halfLifeDays as number) > 0
      ? (opts.halfLifeDays as number)
      : DEFAULT_HALF_LIFE_DAYS;
  const nowMs = Number.isFinite(now) ? now : Number.NaN;

  interface DifficultyAccumulator extends Accumulator {
    difficulty: DifficultyBucket;
  }
  const acc = new Map<string, DifficultyAccumulator>();
  for (const e of contribs) {
    const difficulty = e.difficulty;
    if (!difficulty) continue; // unbucketed ⇒ category-level view only
    const tsMs = Date.parse(e.ts);
    const ageDays = Number.isFinite(nowMs) ? Math.max(0, (nowMs - tsMs) / MS_PER_DAY) : 0;
    const weight = Math.pow(0.5, ageDays / halfLife);

    const modelKey = modelKeyFromOutcome(e)!;
    const accKey = [modelKey, e.category, difficulty].join(SEP);
    let a = acc.get(accKey);
    if (!a) {
      a = { modelKey, category: e.category, difficulty, weightSum: 0, weightedValueSum: 0 };
      acc.set(accKey, a);
    }
    a.weightSum += weight;
    a.weightedValueSum += weight * verdictValue(e.verdict);
  }

  const overlay: ObservedCapabilityByModelDifficulty = Object.create(null);
  for (const a of acc.values()) {
    if (!(a.weightSum > 0) || !Number.isFinite(a.weightSum)) continue;
    const byCategory = overlay[a.modelKey] ?? (overlay[a.modelKey] = Object.create(null));
    const byDifficulty = byCategory[a.category] ?? (byCategory[a.category] = Object.create(null));
    byDifficulty[a.difficulty] = { rate: a.weightedValueSum / a.weightSum, n: a.weightSum };
  }
  return overlay;
}

export interface CapabilityInterval {
  lo: number;
  hi: number;
  n: number;
  rate: number;
}

export interface CapabilityIntervalOptions {
  confidence?: number;
}

function zValueForConfidence(confidence: number): number {
  const map: Record<number, number> = {
    0.80: 1.28155,
    0.85: 1.43953,
    0.90: 1.64485,
    0.95: 1.95996,
    0.98: 2.32635,
    0.99: 2.57583,
    0.999: 3.29053,
  };
  return map[confidence] ?? 1.95996;
}

/**
 * Computes a Wilson score interval for the proportion observed.rate with sample size observed.n.
 * Returns undefined if n <= 0 or not finite, or rate is not finite.
 */
export function capabilityInterval(
  observed: { rate: number; n: number },
  opts?: CapabilityIntervalOptions,
): CapabilityInterval | undefined {
  if (!observed) return undefined;
  const rawN = observed.n;
  const rawRate = observed.rate;
  if (!Number.isFinite(rawN) || rawN <= 0 || !Number.isFinite(rawRate) || rawRate < 0 || rawRate > 1) {
    return undefined;
  }
  const rate = rawRate;
  const confidence = opts?.confidence ?? 0.95;
  const z = zValueForConfidence(confidence);
  const z2 = z * z;

  const denom = 1 + z2 / rawN;
  if (!Number.isFinite(denom) || denom === 0) {
    return undefined;
  }

  const center = (rate + z2 / (2 * rawN)) / denom;
  const inner = (rate * (1 - rate)) / rawN + z2 / (4 * rawN * rawN);
  if (inner < 0 || !Number.isFinite(inner)) {
    return undefined;
  }

  const spread = (z * Math.sqrt(inner)) / denom;
  if (!Number.isFinite(center) || !Number.isFinite(spread)) {
    return undefined;
  }

  const lo = Math.max(0, Math.min(1, center - spread));
  const hi = Math.max(0, Math.min(1, center + spread));

  return { lo, hi, n: rawN, rate };
}

/**
 * Computes the age in days of the newest contributing outcome.
 * Returns undefined when there are no contributing outcomes.
 */
export function evidenceFreshnessDays(
  outcomes: readonly OutcomeEvent[],
  now: number,
): number | undefined {
  if (!Number.isFinite(now)) {
    return undefined;
  }
  if (!outcomes || outcomes.length === 0) {
    return undefined;
  }
  let maxTs = -Infinity;
  let hasValid = false;
  for (const e of outcomes) {
    if (!e.ts) continue;
    const tsMs = Date.parse(e.ts);
    if (Number.isFinite(tsMs)) {
      if (tsMs > maxTs) {
        maxTs = tsMs;
      }
      hasValid = true;
    }
  }
  if (!hasValid || maxTs === -Infinity) {
    return undefined;
  }
  const ageDays = (now - maxTs) / MS_PER_DAY;
  return Math.max(0, ageDays);
}