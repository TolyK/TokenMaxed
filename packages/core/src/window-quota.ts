/**
 * Rolling-window request-count quota math (e.g. subscription plans that gate on
 * requests in a trailing ~5h window). Pure: no I/O, never throws.
 */

/** Default rolling window: five hours in milliseconds. */
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

/** Window consumption thresholds (fraction of limit used). */
export const WINDOW_WARN_USED = 0.7;
export const WINDOW_CRITICAL_USED = 0.9;

/** A lane's rolling-window request quota status. */
export type WindowLevel = 'ok' | 'warn' | 'critical';

function effectiveWindowMs(windowMs: number): number {
  return windowMs > 0 && Number.isFinite(windowMs) ? windowMs : FIVE_HOUR_MS;
}

function saneCount(count: number): number {
  if (!Number.isFinite(count) || count < 0) return 0;
  return count;
}

/**
 * Count timestamps that fall in the open-closed window `(now - windowMs, now]`.
 * Non-finite timestamps are ignored; future timestamps are excluded.
 */
export function requestsInWindow(
  timestampsMs: readonly number[],
  now: number,
  windowMs = FIVE_HOUR_MS,
): number {
  const w = effectiveWindowMs(windowMs);
  if (!Number.isFinite(now)) return 0;
  const cutoff = now - w;
  let n = 0;
  for (const t of timestampsMs) {
    if (!Number.isFinite(t)) continue;
    if (t > cutoff && t <= now) n += 1;
  }
  return n;
}

/** Fraction of the window limit consumed, in [0, ∞). 0 when there is no limit (!(limit > 0)). */
export function windowUsedFraction(count: number, limit: number): number {
  if (!(limit > 0)) return 0;
  return saneCount(count) / limit;
}

/** Remaining headroom in [0, 1]. 1 when there is no limit (!(limit > 0)). */
export function windowHeadroom(count: number, limit: number): number {
  if (!(limit > 0)) return 1;
  const remaining = 1 - saneCount(count) / limit;
  if (remaining < 0) return 0;
  if (remaining > 1) return 1;
  return remaining;
}

/** Classify a used-fraction into ok / warn / critical. */
export function windowLevel(usedFraction: number): WindowLevel {
  if (usedFraction >= WINDOW_CRITICAL_USED) return 'critical';
  if (usedFraction >= WINDOW_WARN_USED) return 'warn';
  return 'ok';
}

/**
 * Milliseconds until the oldest in-window request ages out (frees one slot).
 * 0 when no timestamps are in the window.
 */
export function msUntilWindowFrees(
  timestampsMs: readonly number[],
  now: number,
  windowMs = FIVE_HOUR_MS,
): number {
  const w = effectiveWindowMs(windowMs);
  if (!Number.isFinite(now)) return 0;
  const cutoff = now - w;
  let oldest: number | undefined;
  for (const t of timestampsMs) {
    if (!Number.isFinite(t)) continue;
    if (t > cutoff && t <= now) {
      if (oldest === undefined || t < oldest) oldest = t;
    }
  }
  if (oldest === undefined) return 0;
  return Math.max(0, Math.floor(oldest + w - now));
}