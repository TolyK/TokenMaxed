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
  routeDecide,
} from '../src/route.ts';
import { selectReviewManager } from '../src/review.ts';
import type { Lane, ObservedCapabilityByLane, ObservedCapabilityByModel, Policy, RouteContext } from '../src/types.ts';

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

// --- P6 Phase 1c: model-keyed overlay lookup ----------------------------------

test('effectiveCapabilityFor with model overlay resolves lane.model to the model key', () => {
  const modelOverlay: ObservedCapabilityByModel = {
    'kimi-k2': { feature: { rate: 1.0, n: DEFAULT_PRIOR_STRENGTH } },
  };
  near(
    effectiveCapabilityFor(lane, 'feature', undefined, { modelOverlay }),
    (0.6 + 1.0) / 2,
  );
  // a different model id is unaffected
  const otherModel: Lane = { ...lane, model: 'other-model' };
  near(effectiveCapabilityFor(otherModel, 'feature', undefined, { modelOverlay }), 0.6);
});

test('lane-with-changed-model: old-model verdicts do not contaminate the new model', () => {
  const oldModelOverlay: ObservedCapabilityByModel = {
    'old-model': { bugfix: { rate: 1.0, n: 100_000 } },
  };
  const newLane: Lane = {
    id: 'repinned-lane',
    kind: 'cli',
    model: 'new-model',
    trust_mode: 'full',
    costBasis: 'subscription',
    provenance: 'moonshot',
    jurisdiction: 'CN',
    capability: { bugfix: 0.5 },
  };
  // The lane now runs new-model; old-model evidence must not lift its score.
  near(effectiveCapabilityFor(newLane, 'bugfix', undefined, { modelOverlay: oldModelOverlay }), 0.5);
  const newModelOverlay: ObservedCapabilityByModel = {
    'new-model': { bugfix: { rate: 1.0, n: 100_000 } },
  };
  near(effectiveCapabilityFor(newLane, 'bugfix', undefined, { modelOverlay: newModelOverlay }), 0.99996, 1e-3);
});

test('capability:0 opt-out survives the model overlay', () => {
  const optout: Lane = { ...lane, capability: { feature: 0 } };
  const modelOverlay: ObservedCapabilityByModel = {
    'kimi-k2': { feature: { rate: 1.0, n: 100_000 } },
  };
  assert.equal(effectiveCapabilityFor(optout, 'feature', undefined, { modelOverlay }), 0);
});

test('zero-change-when-absent: no model overlay equals declared capability', () => {
  const modelOverlay: ObservedCapabilityByModel = {
    'kimi-k2': { feature: { rate: 1.0, n: 100_000 } },
  };
  near(effectiveCapabilityFor(lane, 'feature'), declaredCapabilityFor(lane, 'feature'));
  near(effectiveCapabilityFor(lane, 'feature', undefined, {}), declaredCapabilityFor(lane, 'feature'));
  // model overlay only applies when passed
  near(effectiveCapabilityFor(lane, 'refactor', undefined, { modelOverlay }), 0.5);
});

test('reviewer eligibility is unaffected by the model overlay', () => {
  const subject: Lane = {
    id: 'subj',
    kind: 'cli',
    model: 'subj-m',
    trust_mode: 'full',
    costBasis: 'subscription',
    provenance: 'moonshot',
    jurisdiction: 'CN',
    manager_allowed: false,
    capability: { bugfix: 0.6 },
  };
  const mgr: Lane = {
    id: 'mgr',
    kind: 'cli',
    model: 'mgr-m',
    trust_mode: 'full',
    costBasis: 'subscription',
    provenance: 'anthropic',
    jurisdiction: 'US',
    manager_allowed: true,
    capability: { bugfix: 0.7 },
  };
  const modelOverlay: ObservedCapabilityByModel = {
    'subj-m': { bugfix: { rate: 1.0, n: 100_000 } },
  };
  const ctx: RouteContext = {
    lanes: [subject, mgr],
    policyContext: { repo_class: 'public', sensitivity: 'normal' },
    observedCapabilityByModel: modelOverlay,
  };
  const noPolicy: Policy = {};
  assert.equal(selectReviewManager([subject, mgr], subject, 'bugfix', ctx, noPolicy)?.id, 'mgr');
});

test('routeDecide: model overlay lifts a cheap lane when its model earns evidence', () => {
  const strong = makeLane({
    id: 'strong',
    model: 'strong-m',
    costBasis: 'subscription',
    capability: { bugfix: 0.85 },
  });
  const cheap = makeLane({
    id: 'cheap',
    model: 'cheap-m',
    costBasis: 'local',
    capability: { bugfix: 0.6 },
  });
  const task = { category: 'bugfix' as const };
  const base: RouteContext = {
    lanes: [strong, cheap],
    policyContext: { repo_class: 'public', sensitivity: 'normal' },
  };
  const noPolicy: Policy = {};
  assert.equal(routeDecide(task, base, noPolicy).laneId, 'strong');
  const modelOverlay: ObservedCapabilityByModel = {
    'cheap-m': { bugfix: { rate: 1.0, n: 100_000 } },
  };
  assert.equal(routeDecide(task, { ...base, observedCapabilityByModel: modelOverlay }, noPolicy).laneId, 'cheap');
});

function makeLane(over: Partial<Lane> & { id: string }): Lane {
  return {
    kind: 'cli',
    model: 'm',
    trust_mode: 'full',
    costBasis: 'subscription',
    provenance: 'anthropic',
    jurisdiction: 'US',
    ...over,
  };
}
