/**
 * Failure taxonomy + classification (C-11). Pure. Executors/adapters normalize
 * raw provider errors into a {@link FailureKind}; the router then decides what to
 * do (C-12). Transient failures are eligible for trust-preserving fallback;
 * permanent ones disable the lane / surface an error without blind retries.
 */

import type { RawUsage } from './usage.ts';
import type { LedgerEvent, TaskEvent } from './ledger.ts';
import type { Lane } from './types.ts';

/** Normalized failure categories across lanes/providers. */
export type FailureKind =
  | 'timeout'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'auth_failed'
  | 'bad_request'
  | 'provider_error'
  | 'policy_blocked'
  | 'insufficient_context';

/** All failure kinds, canonical order. */
export const FAILURE_KINDS: readonly FailureKind[] = [
  'timeout',
  'rate_limited',
  'quota_exhausted',
  'auth_failed',
  'bad_request',
  'provider_error',
  'policy_blocked',
  'insufficient_context',
];

/**
 * Whether a failure is transient — eligible for fallback to another lane.
 * Transient: timeout, rate_limited, quota_exhausted (lane temporarily out of
 * credits), provider_error (5xx). Permanent: auth_failed, bad_request (retrying
 * the same input won't help), policy_blocked (a deliberate gate decision — never
 * "fall back" around the policy), and insufficient_context (a worker declared it
 * lacks repo/tool access; retrying the same blind input cannot help — it is handed
 * to a full lane, not retried on another worker).
 */
export function isTransient(kind: FailureKind): boolean {
  switch (kind) {
    case 'timeout':
    case 'rate_limited':
    case 'quota_exhausted':
    case 'provider_error':
      return true;
    case 'auth_failed':
    case 'bad_request':
    case 'policy_blocked':
    case 'insufficient_context':
      return false;
  }
}

/**
 * Whether a lane should be put on cooldown (temporarily skipped) after this
 * failure — true for capacity/rate signals (rate_limited, quota_exhausted).
 */
export function shouldCooldown(kind: FailureKind): boolean {
  return kind === 'rate_limited' || kind === 'quota_exhausted';
}

/**
 * An execution failure that carries its normalized {@link FailureKind}. Executors
 * throw this so callers (runTask) can preserve the category (e.g. quota/auth)
 * instead of flattening everything to a transient provider error.
 */
export class LaneFailure extends Error {
  readonly failureKind: FailureKind;
  /**
   * Usage the lane reported BEFORE failing, when known (e.g. a reasoning model that
   * billed a first call, then the retry hit 429/400). Carried so runTask records the
   * real spend instead of ZERO_USAGE — a metered failed attempt is never under-reported.
   */
  readonly reported?: RawUsage;
  constructor(failureKind: FailureKind, message?: string, reported?: RawUsage) {
    super(message ?? failureKind);
    this.name = 'LaneFailure';
    this.failureKind = failureKind;
    if (reported) this.reported = reported;
  }
}

/** Map an HTTP status to a {@link FailureKind} (the common provider signals). */
export function classifyHttpStatus(status: number): FailureKind {
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 402) return 'quota_exhausted';
  if (status === 401 || status === 403) return 'auth_failed';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'provider_error'; // 5xx and anything else
}

export interface LaneHealth {
  errorRate: number;
  failureRate: number;
  n: number;
  circuitOpen: boolean;
}

export function laneHealth(
  events: readonly LedgerEvent[],
  lane: Lane,
  now: number
): LaneHealth {
  if (!Number.isFinite(now)) {
    return {
      errorRate: 0,
      failureRate: 0,
      n: 0,
      circuitOpen: false,
    };
  }

  const HEALTH_HALF_LIFE_MS = 10 * 60 * 1000; // 10 minutes
  const TRIP_WINDOW_MS = 5 * 60 * 1000;      // 5 minutes
  const COOLDOWN_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes

  // Filter events for this lane: task events only, non-native, ignoring blocked/fallback (insufficient_context is not quality fail), and t <= now.
  const laneEvents = events.filter(
    (e): e is TaskEvent => {
      if (e.event_type !== 'task' || e.laneId !== lane.id || e.status === 'native') {
        return false;
      }
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && t <= now;
    }
  );

  // Sort chronologically
  const sortedEvents = [...laneEvents].sort((a, b) => {
    const ta = Date.parse(a.ts);
    const tb = Date.parse(b.ts);
    if (ta !== tb) return ta - tb;
    return a.seq - b.seq;
  });

  let state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  let lastFailureTime = 0;
  let failuresInWindow: number[] = [];

  for (const e of sortedEvents) {
    const t = Date.parse(e.ts);

    // Transition from OPEN to HALF_OPEN if enough time passed before this event
    if (state === 'OPEN' && t - lastFailureTime >= COOLDOWN_WINDOW_MS) {
      state = 'HALF_OPEN';
    }

    if (e.status === 'ok') {
      if (state === 'HALF_OPEN') {
        state = 'CLOSED';
        failuresInWindow = [];
      }
    } else if (e.status === 'failed') {
      if (state === 'HALF_OPEN') {
        state = 'OPEN';
        lastFailureTime = t;
      } else if (state === 'CLOSED') {
        failuresInWindow.push(t);
        failuresInWindow = failuresInWindow.filter(ft => t - ft <= TRIP_WINDOW_MS);
        if (failuresInWindow.length >= 3) {
          state = 'OPEN';
          lastFailureTime = t;
        }
      } else if (state === 'OPEN') {
        lastFailureTime = t;
      }
    }
  }

  // Check state at current `now`
  if (state === 'OPEN' && now - lastFailureTime >= COOLDOWN_WINDOW_MS) {
    state = 'HALF_OPEN';
  }

  const circuitOpen = (state === 'OPEN');

  // Recency decay weighting for error rates over ok and failed events
  let weightSum = 0;
  let weightedFailures = 0;

  for (const e of sortedEvents) {
    const t = Date.parse(e.ts);
    if (e.status !== 'ok' && e.status !== 'failed') continue;

    const ageMs = Math.max(0, now - t);
    const weight = Math.pow(0.5, ageMs / HEALTH_HALF_LIFE_MS);
    if (Number.isFinite(weight) && weight > 0) {
      weightSum += weight;
      if (e.status === 'failed') {
        weightedFailures += weight;
      }
    }
  }

  const errorRate = weightSum > 0 ? weightedFailures / weightSum : 0;
  const failureRate = errorRate;

  return {
    errorRate: Number.isFinite(errorRate) ? errorRate : 0,
    failureRate: Number.isFinite(failureRate) ? failureRate : 0,
    n: Number.isFinite(weightSum) ? weightSum : 0,
    circuitOpen,
  };
}

export function healthPenaltyFor(health: LaneHealth | undefined): number {
  if (!health) return 0;
  if (health.circuitOpen) {
    return 1.0; // Large penalty (last-resort)
  }
  // Bounded, subtractive health penalty: errorRate * 0.2
  const penalty = health.errorRate * 0.2;
  return Number.isFinite(penalty) ? Math.max(0, Math.min(0.2, penalty)) : 0;
}
