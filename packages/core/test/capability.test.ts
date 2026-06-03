/**
 * F1-S1 — pure capability-feedback blend math. Tests `effectiveCapability`
 * (shrinkage toward the declared prior) and `effectiveCapabilityFor` (overlay
 * lookup). No wiring, no I/O. Relative source import (no-build test rule).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_PRIOR_STRENGTH,
  declaredCapabilityFor,
  effectiveCapability,
  effectiveCapabilityFor,
} from '../src/route.ts';
import type { Lane, ObservedCapabilityByLane } from '../src/types.ts';

/** Assert two floats are equal within a small tolerance. */
function near(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} ≈ ${expected}`);
}

const lane: Lane = {
  id: 'cheap-lane',
  kind: 'cli',
  model: 'kimi-k2',
  trust_mode: 'full',
  costBasis: 'subscription',
  provenance: 'moonshot',
  jurisdiction: 'CN',
  capability: { feature: 0.6, refactor: 0.5 },
};

test('no observed evidence returns the declared prior', () => {
  near(effectiveCapability(0.6, undefined), 0.6);
});

test('n = 0 returns the declared prior (a single review cannot swing routing)', () => {
  near(effectiveCapability(0.6, { rate: 0.0, n: 0 }), 0.6);
});

test('with n == priorStrength the result sits halfway between declared and observed', () => {
  // (k·declared + n·rate)/(k+n) with k=n ⇒ (declared+rate)/2.
  near(effectiveCapability(0.5, { rate: 1.0, n: DEFAULT_PRIOR_STRENGTH }), 0.75);
  near(effectiveCapability(0.8, { rate: 0.0, n: DEFAULT_PRIOR_STRENGTH }), 0.4);
});

test('overwhelming evidence converges toward the observed rate', () => {
  near(effectiveCapability(0.2, { rate: 0.95, n: 100_000 }), 0.95, 1e-3);
});

test('declared and rate are clamped into [0, 1]', () => {
  near(effectiveCapability(2, { rate: 5, n: 4 }), 1); // both clamp to 1
  near(effectiveCapability(-1, { rate: -3, n: 4 }), 0); // both clamp to 0
});

test('non-finite or non-positive n is treated as no evidence (returns declared)', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
    near(effectiveCapability(0.6, { rate: 0.1, n: bad }), 0.6);
  }
});

test('invalid priorStrength falls back to the default', () => {
  const observed = { rate: 1.0, n: DEFAULT_PRIOR_STRENGTH };
  const expected = effectiveCapability(0.5, observed); // default prior
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    near(effectiveCapability(0.5, observed, { priorStrength: bad }), expected);
  }
});

test('a larger priorStrength keeps the result closer to the declared prior', () => {
  const observed = { rate: 1.0, n: 8 };
  const loose = effectiveCapability(0.5, observed, { priorStrength: 2 });
  const tight = effectiveCapability(0.5, observed, { priorStrength: 32 });
  assert.ok(loose > tight, 'smaller prior moves further toward observed');
  assert.ok(tight > 0.5 && loose < 1, 'both stay between declared and observed');
});

test('effectiveCapabilityFor with no overlay equals the declared capability', () => {
  near(effectiveCapabilityFor(lane, 'feature'), declaredCapabilityFor(lane, 'feature'));
  near(effectiveCapabilityFor(lane, 'feature', undefined), 0.6);
  // a category the lane does not declare falls back to the default prior
  near(effectiveCapabilityFor(lane, 'boilerplate'), declaredCapabilityFor(lane, 'boilerplate'));
});

test('effectiveCapabilityFor blends only the matching lane×category entry', () => {
  const overlay: ObservedCapabilityByLane = {
    'cheap-lane': { feature: { rate: 1.0, n: DEFAULT_PRIOR_STRENGTH } },
  };
  // feature has evidence → blended halfway (0.6 declared, 1.0 observed)
  near(effectiveCapabilityFor(lane, 'feature', overlay), (0.6 + 1.0) / 2);
  // refactor has no overlay entry → declared prior unchanged
  near(effectiveCapabilityFor(lane, 'refactor', overlay), 0.5);
  // a different lane id is unaffected
  const other: Lane = { ...lane, id: 'other-lane' };
  near(effectiveCapabilityFor(other, 'feature', overlay), 0.6);
});
