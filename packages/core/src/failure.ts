/**
 * Failure taxonomy + classification (C-11). Pure. Executors/adapters normalize
 * raw provider errors into a {@link FailureKind}; the router then decides what to
 * do (C-12). Transient failures are eligible for trust-preserving fallback;
 * permanent ones disable the lane / surface an error without blind retries.
 */

import type { RawUsage } from './usage.ts';

/** Normalized failure categories across lanes/providers. */
export type FailureKind =
  | 'timeout'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'auth_failed'
  | 'bad_request'
  | 'provider_error'
  | 'policy_blocked';

/** All failure kinds, canonical order. */
export const FAILURE_KINDS: readonly FailureKind[] = [
  'timeout',
  'rate_limited',
  'quota_exhausted',
  'auth_failed',
  'bad_request',
  'provider_error',
  'policy_blocked',
];

/**
 * Whether a failure is transient — eligible for fallback to another lane.
 * Transient: timeout, rate_limited, quota_exhausted (lane temporarily out of
 * credits), provider_error (5xx). Permanent: auth_failed, bad_request (retrying
 * the same input won't help) and policy_blocked (a deliberate gate decision —
 * never "fall back" around the policy).
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
