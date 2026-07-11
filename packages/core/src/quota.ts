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

function axisState(count: number, limit: number): QuotaAxisState {
  const used = windowUsedFraction(count, limit);
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

  const requests = hasWindow || hasWeekRequests ? laneObservations(events, lane.id, false) : [];

  if (hasWindow) {
    const windowMs = typeof lane.window_ms === 'number' && lane.window_ms > 0 ? lane.window_ms : FIVE_HOUR_MS;
    // requestsInWindow shares boundary semantics with amountInWindow; reuse the
    // canonical helper for the count so the summary and this state always agree.
    const count = requestsInWindow(requests.map((o) => o.ts), now, windowMs);
    state.window = axisState(count, lane.requests_per_window!);
    axes.push(state.window);
  }
  if (hasWeekRequests) {
    state.weekRequests = axisState(amountInWindow(requests, now, WEEK_MS), lane.requests_per_week!);
    axes.push(state.weekRequests);
  }
  if (hasWeekTokens) {
    const tokens = laneObservations(events, lane.id, true);
    state.weekTokens = axisState(amountInWindow(tokens, now, WEEK_MS), lane.tokens_per_week!);
    axes.push(state.weekTokens);
  }

  let headroom = 1;
  for (const a of axes) headroom = Math.min(headroom, Math.max(0, 1 - a.used));
  state.headroom = headroom;
  return state;
}

/**
 * The headroom map routing consumes (RouteContext.capHeadroom): lane id →
 * min-axis remaining fraction. Lanes with NO quota config are OMITTED — an
 * absent entry already means full headroom to `capPenaltyFor`, and omitting
 * keeps the zero-change-when-absent invariant literal (no config anywhere ⇒
 * an EMPTY map ⇒ the adapter passes nothing).
 */
export function quotaHeadroomMap(events: readonly LedgerEvent[], lanes: readonly Lane[], now: number): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const lane of lanes) {
    const hasAny =
      (typeof lane.requests_per_window === 'number' && lane.requests_per_window > 0) ||
      (typeof lane.requests_per_week === 'number' && lane.requests_per_week > 0) ||
      (typeof lane.tokens_per_week === 'number' && lane.tokens_per_week > 0);
    if (!hasAny) continue;
    out[lane.id] = laneQuotaState(events, lane, now).headroom;
  }
  return out;
}
