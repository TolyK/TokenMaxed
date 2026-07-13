/**
 * B — quota-brain state (pure). Turns the content-free ledger + a lane's quota
 * config into per-lane quota state routing and reporting consume.
 *
 * HONESTY (law): every count here is the ROUTED share recorded in the local
 * ledger — TokenMaxed cannot see work done outside itself, so these are floors
 * on real usage, never totals. Surfaces label counts `routed`; only
 * projections (B3) are estimates.
 *
 * Pure and clock-injected: no I/O, never throws; a lane with no quota config
 * yields `headroom: 1` and no axes, so routing is byte-identical when the
 * feature is unused (zero-change-when-absent).
 */

import type { LedgerEvent } from './ledger.ts';
import type { Lane } from './types.ts';
import { FIVE_HOUR_MS, requestsInWindow, windowLevel, windowUsedFraction } from './window-quota.ts';
import type { WindowLevel } from './window-quota.ts';

/** Trailing "week" for the weekly axes (7 days, rolling). */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** One weighted consumption observation (requests: amount 1; tokens: in+out). */
export interface QuotaObservation {
  ts: number;
  amount: number;
}

/** One quota axis' state. `used` is a fraction of the limit (may exceed 1). */
export interface QuotaAxisState {
  count: number;
  limit: number;
  used: number;
  level: WindowLevel;
}

/** A lane's full quota state. Axes appear only when configured. */
export interface LaneQuotaState {
  /** Rolling request window (requests_per_window over window_ms | 5h). */
  window?: QuotaAxisState;
  /** Trailing-7d request cap (requests_per_week). */
  weekRequests?: QuotaAxisState;
  /** Trailing-7d token cap (tokens_per_week; tokens_in + tokens_out). */
  weekTokens?: QuotaAxisState;
  /**
   * min over configured axes of remaining fraction, in [0, 1]; 1 when no quota
   * is configured. This is the value RouteContext.capHeadroom consumes.
   */
  headroom: number;
}

/**
 * Extract a lane's weighted consumption observations from the ledger.
 * Routed legs only (`status !== 'native'`); invalid timestamps dropped.
 */
export function laneObservations(
  events: readonly LedgerEvent[],
  laneId: string,
  weightTokens: boolean,
): QuotaObservation[] {
  const out: QuotaObservation[] = [];
  for (const e of events) {
    if (e.event_type !== 'task' || e.laneId !== laneId || e.status === 'native') continue;
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) continue;
    out.push({ ts, amount: weightTokens ? e.tokens_in + e.tokens_out : 1 });
  }
  return out;
}

/** Sum of observation amounts inside the open-closed window `(now - windowMs, now]`. */
function amountInWindow(observations: readonly QuotaObservation[], now: number, windowMs: number): number {
  let sum = 0;
  for (const o of observations) {
    if (o.ts > now || o.ts <= now - windowMs) continue;
    if (!(Number.isFinite(o.amount) && o.amount > 0)) continue;
    sum += o.amount;
  }
  return sum;
}

function axisState(count: number, limit: number, reserve = 0, calibration = 0): QuotaAxisState {
  const rawUsed = windowUsedFraction(count, limit);
  const floorUsed = Math.max(rawUsed, calibration);
  const r = Math.max(0, Math.min(0.9999, reserve));
  const mult = 1 / (1 - r);
  const used = floorUsed === 0 ? 0 : floorUsed * mult;
  return { count, limit, used, level: windowLevel(used) };
}

/**
 * A lane's quota state as of `now` (epoch ms). Only configured axes appear;
 * `headroom` = min remaining fraction across them (1 when none configured).
 */
export function laneQuotaState(events: readonly LedgerEvent[], lane: Lane, now: number): LaneQuotaState {
  const axes: QuotaAxisState[] = [];
  const state: LaneQuotaState = { headroom: 1 };

  const hasWindow = typeof lane.requests_per_window === 'number' && lane.requests_per_window > 0;
  const hasWeekRequests = typeof lane.requests_per_week === 'number' && lane.requests_per_week > 0;
  const hasWeekTokens = typeof lane.tokens_per_week === 'number' && lane.tokens_per_week > 0;
  if (!hasWindow && !hasWeekRequests && !hasWeekTokens) return state;

  const reserve = lane.reserve_fraction ?? 0;
  const calibration = lane.calibration_fraction ?? 0;
  const requests = hasWindow || hasWeekRequests ? laneObservations(events, lane.id, false) : [];

  if (hasWindow) {
    const windowMs = typeof lane.window_ms === 'number' && lane.window_ms > 0 ? lane.window_ms : FIVE_HOUR_MS;
    // requestsInWindow shares boundary semantics with amountInWindow; reuse the
    // canonical helper for the count so the summary and this state always agree.
    const count = requestsInWindow(requests.map((o) => o.ts), now, windowMs);
    state.window = axisState(count, lane.requests_per_window!, reserve, calibration);
    axes.push(state.window);
  }
  if (hasWeekRequests) {
    state.weekRequests = axisState(amountInWindow(requests, now, WEEK_MS), lane.requests_per_week!, reserve, calibration);
    axes.push(state.weekRequests);
  }
  if (hasWeekTokens) {
    const tokens = laneObservations(events, lane.id, true);
    state.weekTokens = axisState(amountInWindow(tokens, now, WEEK_MS), lane.tokens_per_week!, reserve, calibration);
    axes.push(state.weekTokens);
  }

  let headroom = 1;
  for (const a of axes) headroom = Math.min(headroom, Math.max(0, 1 - a.used));
  state.headroom = headroom;
  return state;
}

// ---------------------------------------------------------------------------
// B3 — depletion projection (plan §1.4). Rolling-window-correct: consumption
// EXPIRES out of a trailing window, so `remaining / ingress-rate` would forecast
// depletion even for stable occupancy. Instead we simulate NET occupancy
// forward: continuous arrivals (λ·dt, λ in units/ms) over the DISCRETE schedule
// of known expirations (each observation leaves at ts + windowMs), with the
// earliest limit-crossing found analytically per piecewise-linear segment.
// ---------------------------------------------------------------------------

/** Gates for rendering a projection at all / with a time (plan §1.4). */
const MIN_SAMPLES = 8;
const MIN_SPAN_FRACTION = 0.25;
const MAX_HALF_RATE_RATIO = 3;
const MODERATE_SPAN_FRACTION = 0.5;
const MODERATE_HALF_RATE_RATIO = 2;

export interface DepletionProjection {
  /** ms from `now` until projected occupancy first reaches the limit. */
  etaMs: number;
  /**
   * Rendering guidance (labels are NOT printed): `moderate` ⇒ a relative
   * duration may be shown; `low` ⇒ only a timeless "approaching cap" notice.
   */
  confidence: 'low' | 'moderate';
}

/**
 * Project the earliest time the rolling-window occupancy reaches `limit`.
 * Undefined when the evidence gates fail (omission over false precision) or
 * when occupancy never crosses within one window length (stable/falling).
 * Expiration-first at same-instant ties: an expiring amount is subtracted
 * before the crossing test at that instant.
 */
export function projectOccupancy(
  observations: readonly QuotaObservation[],
  limit: number,
  windowMs: number,
  now: number,
  calibrationAmount = 0,
): DepletionProjection | undefined {
  if (!(limit > 0) || !(windowMs > 0) || !Number.isFinite(now)) return undefined;
  // In-window, valid observations — same (now - window, now] boundary as the counts.
  const inWindow = observations
    .filter((o) => Number.isFinite(o.ts) && o.ts > now - windowMs && o.ts <= now && Number.isFinite(o.amount) && o.amount > 0)
    .sort((a, b) => a.ts - b.ts);
  if (inWindow.length < MIN_SAMPLES) return undefined;

  // Coverage: the observed span must fill enough of the burn horizon.
  const span = inWindow[inWindow.length - 1]!.ts - inWindow[0]!.ts;
  const spanFraction = span / windowMs;
  if (spanFraction < MIN_SPAN_FRACTION) return undefined;

  // Stability: weighted rate of each half of the horizon; both must be positive
  // and comparable (max/min), else omit (one active burst is not a trend).
  const mid = now - windowMs / 2;
  let firstHalf = 0;
  let secondHalf = 0;
  for (const o of inWindow) {
    if (o.ts <= mid) firstHalf += o.amount;
    else secondHalf += o.amount;
  }
  if (!(firstHalf > 0) || !(secondHalf > 0)) return undefined;
  const ratio = Math.max(firstHalf, secondHalf) / Math.min(firstHalf, secondHalf);
  if (ratio >= MAX_HALF_RATE_RATIO) return undefined;

  const total = firstHalf + secondHalf;
  const lambda = total / windowMs; // units per ms over the full horizon

  // Simulate: piecewise-linear occupancy between expirations.
  let occupancy = Math.max(total, calibrationAmount);
  if (occupancy >= limit) return { etaMs: 0, confidence: confidenceOf(spanFraction, ratio) };
  const expirations = inWindow.map((o) => ({ at: o.ts + windowMs, amount: o.amount }));
  let t = now;
  let idx = 0;
  const horizonEnd = now + windowMs;
  while (t < horizonEnd) {
    const nextExpiry = idx < expirations.length ? Math.min(expirations[idx]!.at, horizonEnd) : horizonEnd;
    // Crossing strictly inside the segment [t, nextExpiry)?
    if (lambda > 0) {
      const tCross = t + (limit - occupancy) / lambda;
      if (tCross < nextExpiry) return { etaMs: tCross - now, confidence: confidenceOf(spanFraction, ratio) };
    }
    if (nextExpiry >= horizonEnd) break;
    // Expiration-first at the boundary instant: drop, then continue.
    occupancy += lambda * (nextExpiry - t) - expirations[idx]!.amount;
    t = nextExpiry;
    idx += 1;
  }
  return undefined; // stable or falling — no depletion within one window
}

function confidenceOf(spanFraction: number, ratio: number): 'low' | 'moderate' {
  return spanFraction >= MODERATE_SPAN_FRACTION && ratio <= MODERATE_HALF_RATE_RATIO ? 'moderate' : 'low';
}

/** A lane's earliest projected depletion across its configured axes. */
export interface LaneDepletionForecast extends DepletionProjection {
  axis: 'window' | 'weekRequests' | 'weekTokens';
}

/**
 * Run the projection for every configured axis and return the EARLIEST
 * depletion, if any axis projects one. Same routed-share-only caveat as all
 * quota state: this extrapolates only what TokenMaxed itself routed.
 */
export function laneDepletionForecast(events: readonly LedgerEvent[], lane: Lane, now: number): LaneDepletionForecast | undefined {
  const axes: Array<{ axis: LaneDepletionForecast['axis']; limit: number | undefined; windowMs: number; weighted: boolean }> = [
    {
      axis: 'window',
      limit: lane.requests_per_window,
      windowMs: typeof lane.window_ms === 'number' && lane.window_ms > 0 ? lane.window_ms : FIVE_HOUR_MS,
      weighted: false,
    },
    { axis: 'weekRequests', limit: lane.requests_per_week, windowMs: WEEK_MS, weighted: false },
    { axis: 'weekTokens', limit: lane.tokens_per_week, windowMs: WEEK_MS, weighted: true },
  ];
  let best: LaneDepletionForecast | undefined;
  let requests: QuotaObservation[] | undefined;
  let tokens: QuotaObservation[] | undefined;
  const r = Math.max(0, Math.min(0.9999, lane.reserve_fraction ?? 0));
  const reserveFactor = 1 - r;
  for (const a of axes) {
    if (!(typeof a.limit === 'number' && a.limit > 0)) continue;
    const obs = a.weighted
      ? (tokens ??= laneObservations(events, lane.id, true))
      : (requests ??= laneObservations(events, lane.id, false));
    const usableLimit = a.limit * reserveFactor;
    const calibrationAmount = (lane.calibration_fraction ?? 0) * a.limit;
    const p = projectOccupancy(obs, usableLimit, a.windowMs, now, calibrationAmount);
    if (p && (best === undefined || p.etaMs < best.etaMs)) best = { ...p, axis: a.axis };
  }
  return best;
}

function isSafeMs(val: any): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= Number.MAX_SAFE_INTEGER;
}

/**
 * Compute the pace pressure fraction in [0, 1] based on projected depletion vs target time.
 * If projected depletion ETA is before the target, return the shortfall as a fraction of now -> target.
 */
export function computePacePressure(
  forecast: { etaMs: number } | undefined,
  targetMs: number | undefined,
  now: number,
): number {
  if (!isSafeMs(now) || !isSafeMs(targetMs) || !forecast || !isSafeMs(forecast.etaMs)) {
    return 0;
  }
  if (targetMs <= now) return 0;
  const etaTimeMs = now + forecast.etaMs;
  if (!Number.isFinite(etaTimeMs) || etaTimeMs > Number.MAX_SAFE_INTEGER) return 0;
  if (etaTimeMs >= targetMs) return 0;
  const shortfall = targetMs - etaTimeMs;
  const total = targetMs - now;
  if (total <= 0 || !Number.isFinite(shortfall) || !Number.isFinite(total)) return 0;
  const pressure = shortfall / total;
  return Number.isFinite(pressure) ? Math.max(0, Math.min(1, pressure)) : 0;
}

/**
 * Adjust the headroom by subtracting the pace pressure.
 */
export function adjustHeadroomForPace(
  headroom: number,
  forecast: { etaMs: number } | undefined,
  targetMs: number | undefined,
  now: number,
): number {
  const safeHeadroom = (typeof headroom === 'number' && Number.isFinite(headroom)) ? headroom : 0;
  const pressure = computePacePressure(forecast, targetMs, now);
  const result = safeHeadroom - pressure;
  return Number.isFinite(result) ? Math.max(0, Math.min(1, result)) : 0;
}

/**
 * The headroom map routing consumes (RouteContext.capHeadroom): lane id →
 * min-axis remaining fraction. Lanes with NO quota config are OMITTED — an
 * absent entry already means full headroom to `capPenaltyFor`, and omitting
 * keeps the zero-change-when-absent invariant literal (no config anywhere ⇒
 * an EMPTY map ⇒ the adapter passes nothing).
 */
export function quotaHeadroomMap(
  events: readonly LedgerEvent[],
  lanes: readonly Lane[],
  now: number,
  targets?: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const lane of lanes) {
    const hasAny =
      (typeof lane.requests_per_window === 'number' && lane.requests_per_window > 0) ||
      (typeof lane.requests_per_week === 'number' && lane.requests_per_week > 0) ||
      (typeof lane.tokens_per_week === 'number' && lane.tokens_per_week > 0);
    if (!hasAny) continue;
    let headroom = laneQuotaState(events, lane, now).headroom;
    if (!Number.isFinite(headroom)) {
      headroom = 1;
    }
    const targetMs = targets?.[lane.id];
    if (targetMs !== undefined && targetMs > now) {
      const forecast = laneDepletionForecast(events, lane, now);
      if (forecast && forecast.confidence === 'moderate') {
        headroom = adjustHeadroomForPace(headroom, forecast, targetMs, now);
      }
    }
    if (!Number.isFinite(headroom)) {
      headroom = 1;
    }
    out[lane.id] = headroom;
  }
  return out;
}

export interface QuotaEstimate {
  routedFraction: number;
  reportedFraction?: number;
  inferredFraction?: number;
  lowerBound: number;
  pointEstimate: number;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  dominantSource: 'routed' | 'reported' | 'inferred';
}

/**
 * Pure confidence-bounded quota estimate fusion. Fuses routed, calibration (reported),
 * and inferred (routed-share) signals for the lane's binding/most-used axis.
 */
export function quotaEstimate(
  lane: Lane,
  events: readonly LedgerEvent[],
  opts: { calibrationFraction?: number; routedShare?: number } | undefined,
  now: number,
): QuotaEstimate {
  const laneCopy = {
    ...lane,
    reserve_fraction: 0,
    calibration_fraction: 0,
  };
  const s = laneQuotaState(events, laneCopy, now);

  const axes: QuotaAxisState[] = [];
  if (s.window) axes.push(s.window);
  if (s.weekRequests) axes.push(s.weekRequests);
  if (s.weekTokens) axes.push(s.weekTokens);

  if (axes.length === 0) {
    return {
      routedFraction: 0,
      lowerBound: 0,
      pointEstimate: 0,
      confidence: 'unknown',
      dominantSource: 'routed',
    };
  }

  // Find the axis with the highest count/limit (raw used)
  let bindingAxis = axes[0]!;
  for (let i = 1; i < axes.length; i++) {
    if (axes[i]!.used > bindingAxis.used) {
      bindingAxis = axes[i]!;
    }
  }

  let routedFraction = bindingAxis.used; // count/limit since reserve=0 and calibration=0
  if (typeof routedFraction !== 'number' || !Number.isFinite(routedFraction) || Number.isNaN(routedFraction)) {
    routedFraction = 0;
  }

  let reportedFraction: number | undefined;
  if (
    opts &&
    typeof opts.calibrationFraction === 'number' &&
    Number.isFinite(opts.calibrationFraction) &&
    !Number.isNaN(opts.calibrationFraction) &&
    opts.calibrationFraction >= 0 &&
    opts.calibrationFraction <= 1
  ) {
    reportedFraction = opts.calibrationFraction;
  }
  if (reportedFraction !== undefined && (typeof reportedFraction !== 'number' || !Number.isFinite(reportedFraction) || Number.isNaN(reportedFraction))) {
    reportedFraction = undefined;
  }

  let inferredFraction: number | undefined;
  if (
    opts &&
    typeof opts.routedShare === 'number' &&
    Number.isFinite(opts.routedShare) &&
    !Number.isNaN(opts.routedShare) &&
    opts.routedShare > 0 &&
    opts.routedShare <= 1
  ) {
    const rawInferred = routedFraction / opts.routedShare;
    if (Number.isFinite(rawInferred) && !Number.isNaN(rawInferred)) {
      inferredFraction = Math.max(0, Math.min(1, rawInferred));
    }
  }

  let lowerBound = Math.max(routedFraction, reportedFraction !== undefined ? reportedFraction : 0);
  if (typeof lowerBound !== 'number' || !Number.isFinite(lowerBound) || Number.isNaN(lowerBound)) {
    lowerBound = 0;
  }

  let pointEstimate = Math.max(
    routedFraction,
    reportedFraction !== undefined ? reportedFraction : 0,
    inferredFraction !== undefined ? inferredFraction : 0
  );
  if (typeof pointEstimate !== 'number' || !Number.isFinite(pointEstimate) || Number.isNaN(pointEstimate)) {
    pointEstimate = 0;
  }

  let confidence: 'high' | 'medium' | 'low' | 'unknown';
  let dominantSource: 'routed' | 'reported' | 'inferred';

  if (reportedFraction === undefined && inferredFraction === undefined) {
    // NOTE: Confidence is "high" only for the observed routed usage (which is a strict lower bound / floor).
    // It does NOT represent high confidence in the overall subscription total (which is unknown since
    // no calibration or routed-share was provided to estimate total usage).
    confidence = 'high';
    dominantSource = 'routed';
  } else {
    const rVal = routedFraction;
    const repVal = reportedFraction !== undefined ? reportedFraction : -1;
    const infVal = inferredFraction !== undefined ? inferredFraction : -1;

    if (infVal > rVal && infVal > repVal) {
      confidence = 'low';
      dominantSource = 'inferred';
    } else if (repVal >= rVal && repVal >= infVal) {
      confidence = 'medium';
      dominantSource = 'reported';
    } else {
      confidence = 'medium';
      dominantSource = 'routed';
    }
  }

  return {
    routedFraction,
    ...(reportedFraction !== undefined ? { reportedFraction } : {}),
    ...(inferredFraction !== undefined ? { inferredFraction } : {}),
    lowerBound,
    pointEstimate,
    confidence,
    dominantSource,
  };
}


