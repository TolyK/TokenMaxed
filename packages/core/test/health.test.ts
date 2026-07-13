import assert from 'node:assert/strict';
import { test } from 'node:test';

import { laneHealth, healthPenaltyFor, routeDecide } from '../src/index.ts';
import type { LedgerEvent, Lane, Task, Policy, RouteContext } from '../src/index.ts';

function mockTaskEvent(laneId: string, status: 'ok' | 'failed', ts: string, seq: number): LedgerEvent {
  return {
    event_type: 'task',
    schema_version: 2,
    id: `event-${seq}`,
    seq,
    ts,
    task_id: `task-${seq}`,
    attempt: 0,
    category: 'bugfix',
    laneId,
    model: 'some-model',
    trust_mode: 'full',
    provenance: 'provider',
    status,
    tokens_in: 100,
    tokens_out: 200,
    tokens_estimated: false,
    actual_cost: 0.01,
    frontier_cost: 0.05,
    metered_spent: 0.01,
    frontier_avoided: 0.04,
    metered_avoided: 0.04,
    policy_verdict: 'allow',
  };
}

const mockLane: Lane = {
  id: 'lane-a',
  kind: 'api',
  model: 'some-model',
  costBasis: 'metered',
  trust_mode: 'full',
  provenance: 'provider',
  jurisdiction: 'us',
  capability: { bugfix: 0.8 },
};

test('laneHealth: empty ledger/no failure evidence gets errorRate=0 and circuitOpen=false', () => {
  const health = laneHealth([], mockLane, Date.now());
  assert.equal(health.errorRate, 0);
  assert.equal(health.circuitOpen, false);
  assert.equal(healthPenaltyFor(health), 0);
});

test('laneHealth: recency decay causes older failures to weigh less', () => {
  const now = Date.now();
  // 10 minutes half life.
  // One failure right now, one success 10 minutes ago, one success 20 minutes ago.
  const t0 = new Date(now).toISOString();
  const t1 = new Date(now - 10 * 60 * 1000).toISOString();
  const t2 = new Date(now - 20 * 60 * 1000).toISOString();

  const events = [
    mockTaskEvent('lane-a', 'failed', t0, 3),
    mockTaskEvent('lane-a', 'ok', t1, 2),
    mockTaskEvent('lane-a', 'ok', t2, 1),
  ];

  const health = laneHealth(events, mockLane, now);
  // Weights: t0 -> age=0 -> weight=1.0 (failed)
  //          t1 -> age=10m -> weight=0.5 (ok)
  //          t2 -> age=20m -> weight=0.25 (ok)
  // Total weight = 1.75
  // Weighted failures = 1.0
  // errorRate = 1.0 / 1.75 = 0.5714...
  assert.ok(Math.abs(health.errorRate - 0.5714) < 0.01);
  assert.equal(health.circuitOpen, false);
});

test('laneHealth: repeated failures (3 in 5m window) trips the circuit breaker', () => {
  const now = Date.now();
  const t0 = new Date(now).toISOString();
  const t1 = new Date(now - 1 * 60 * 1000).toISOString();
  const t2 = new Date(now - 2 * 60 * 1000).toISOString();

  const events = [
    mockTaskEvent('lane-a', 'failed', t2, 1),
    mockTaskEvent('lane-a', 'failed', t1, 2),
    mockTaskEvent('lane-a', 'failed', t0, 3),
  ];

  const health = laneHealth(events, mockLane, now);
  assert.equal(health.circuitOpen, true);
  assert.equal(healthPenaltyFor(health), 1.0);
});

test('laneHealth: circuit breaker recovers (half-open) after cooldown window', () => {
  const now = Date.now();
  const t0 = new Date(now - 6 * 60 * 1000).toISOString(); // 6m ago
  const t1 = new Date(now - 7 * 60 * 1000).toISOString(); // 7m ago
  const t2 = new Date(now - 8 * 60 * 1000).toISOString(); // 8m ago

  const events = [
    mockTaskEvent('lane-a', 'failed', t2, 1),
    mockTaskEvent('lane-a', 'failed', t1, 2),
    mockTaskEvent('lane-a', 'failed', t0, 3),
  ];

  const health = laneHealth(events, mockLane, now);
  // Since 6 minutes have passed (> 5m cooldown), the circuit breaker recovers (circuitOpen=false)
  assert.equal(health.circuitOpen, false);
  assert.ok(healthPenaltyFor(health) < 1.0);
});

test('laneHealth: circuit breaker exact-boundary transition (at exactly cooldown expiry)', () => {
  const now = Date.now();
  const COOLDOWN_WINDOW_MS = 5 * 60 * 1000;
  // The last failure happened exactly COOLDOWN_WINDOW_MS ago.
  const t0 = new Date(now - COOLDOWN_WINDOW_MS).toISOString();
  const t1 = new Date(now - COOLDOWN_WINDOW_MS - 1 * 60 * 1000).toISOString();
  const t2 = new Date(now - COOLDOWN_WINDOW_MS - 2 * 60 * 1000).toISOString();

  const events = [
    mockTaskEvent('lane-a', 'failed', t2, 1),
    mockTaskEvent('lane-a', 'failed', t1, 2),
    mockTaskEvent('lane-a', 'failed', t0, 3),
  ];

  const health = laneHealth(events, mockLane, now);
  // At exactly expiry, the circuit breaker must transition out of OPEN (circuitOpen=false)
  assert.equal(health.circuitOpen, false);
});

test('laneHealth: half-open success closes circuit; half-open failure immediately trips it back to open', () => {
  const now = Date.now();
  const t2 = new Date(now - 8 * 60 * 1000).toISOString();
  const t1 = new Date(now - 7 * 60 * 1000).toISOString();
  const t0 = new Date(now - 6 * 60 * 1000).toISOString();

  // Test success:
  const successEvent = mockTaskEvent('lane-a', 'ok', new Date(now - 1 * 60 * 1000).toISOString(), 4);
  const healthSuccess = laneHealth([
    mockTaskEvent('lane-a', 'failed', t2, 1),
    mockTaskEvent('lane-a', 'failed', t1, 2),
    mockTaskEvent('lane-a', 'failed', t0, 3),
    successEvent,
  ], mockLane, now);
  assert.equal(healthSuccess.circuitOpen, false);

  // Test failure:
  const failEvent = mockTaskEvent('lane-a', 'failed', new Date(now - 1 * 60 * 1000).toISOString(), 4);
  const healthFailure = laneHealth([
    mockTaskEvent('lane-a', 'failed', t2, 1),
    mockTaskEvent('lane-a', 'failed', t1, 2),
    mockTaskEvent('lane-a', 'failed', t0, 3),
    failEvent,
  ], mockLane, now);
  // It fails while half-open, immediately opening the circuit
  assert.equal(healthFailure.circuitOpen, true);
});

test('laneHealth: finite safety is guaranteed', () => {
  const health1 = laneHealth([], mockLane, Number.NaN);
  assert.equal(health1.errorRate, 0);
  assert.equal(health1.circuitOpen, false);

  const health2 = laneHealth([], mockLane, Infinity);
  assert.equal(health2.errorRate, 0);
  assert.equal(health2.circuitOpen, false);

  assert.equal(healthPenaltyFor(undefined), 0);
});

test('laneHealth: ignores events with timestamp in the future', () => {
  const now = Date.now();
  // 3 failures dated tomorrow. These should be ignored and not trip the circuit breaker today.
  const tFuture = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const events = [
    mockTaskEvent('lane-a', 'failed', tFuture, 1),
    mockTaskEvent('lane-a', 'failed', tFuture, 2),
    mockTaskEvent('lane-a', 'failed', tFuture, 3),
  ];

  const health = laneHealth(events, mockLane, now);
  assert.equal(health.circuitOpen, false);
  assert.equal(health.errorRate, 0);
});

test('routing integration: unhealthy lane is deprioritized vs healthy lane', () => {
  const lane1: Lane = { id: 'lane-1', kind: 'api', model: 'model-x', costBasis: 'local', trust_mode: 'full', provenance: 'provider', jurisdiction: 'us', capability: { bugfix: 0.8 } };
  const lane2: Lane = { id: 'lane-2', kind: 'api', model: 'model-y', costBasis: 'local', trust_mode: 'full', provenance: 'provider', jurisdiction: 'us', capability: { bugfix: 0.8 } };

  const task: Task = { category: 'bugfix' };
  const policy: Policy = { rules: [] };

  // Lane 1 is unhealthy (penalty 0.15), Lane 2 is healthy (penalty 0)
  const ctx: RouteContext = {
    lanes: [lane1, lane2],
    healthPenalty: { 'lane-1': 0.15, 'lane-2': 0.0 },
    gateReady: true,
  };

  const decision = routeDecide(task, ctx, policy);
  // Lane 2 should win because Lane 1 has a penalty
  assert.equal(decision.laneId, 'lane-2');
});

test('routing integration: health never hard-blocks (unhealthy lane still wins if it is the only capable one)', () => {
  const lane1: Lane = { id: 'lane-1', kind: 'api', model: 'model-x', costBasis: 'local', trust_mode: 'full', provenance: 'provider', jurisdiction: 'us', capability: { bugfix: 0.8 } };

  const task: Task = { category: 'bugfix' };
  const policy: Policy = { rules: [] };

  // Lane 1 has a large penalty (circuit open, 1.0)
  const ctx: RouteContext = {
    lanes: [lane1],
    healthPenalty: { 'lane-1': 1.0 },
    gateReady: true,
  };

  const decision = routeDecide(task, ctx, policy);
  // Lane 1 should still win since it's the only candidate
  assert.equal(decision.laneId, 'lane-1');
});

test('routing integration: clamps health penalty to [0, 1.0] to prevent negative or infinite values from breaking routing', () => {
  const lane1Less: Lane = { id: 'lane-1', kind: 'api', model: 'model-x', costBasis: 'local', trust_mode: 'full', provenance: 'provider', jurisdiction: 'us', capability: { bugfix: 0.8 } };
  const lane2More: Lane = { id: 'lane-2', kind: 'api', model: 'model-y', costBasis: 'local', trust_mode: 'full', provenance: 'provider', jurisdiction: 'us', capability: { bugfix: 0.9 } };

  const task: Task = { category: 'bugfix' };
  const policy: Policy = { rules: [] };

  const ctxClamped: RouteContext = {
    lanes: [lane1Less, lane2More],
    healthPenalty: { 'lane-1': -10.0, 'lane-2': 0 },
    gateReady: true,
  };
  const decisionClamped = routeDecide(task, ctxClamped, policy);
  assert.equal(decisionClamped.laneId, 'lane-2'); // Clamped to 0, so lane-2 (0.9) wins.

  const ctxNaN: RouteContext = {
    lanes: [lane1Less, lane2More],
    healthPenalty: { 'lane-1': Number.NaN, 'lane-2': Infinity },
    gateReady: true,
  };
  const decisionNaN = routeDecide(task, ctxNaN, policy);
  assert.equal(decisionNaN.laneId, 'lane-2'); // Clamped to 0, so lane-2 (0.9) wins.
});

test('routing integration: ENTIRE RouteDecision is byte-identical and has no health fields when health is disabled', () => {
  const lane1: Lane = {
    id: 'lane-1',
    kind: 'api',
    model: 'model-x',
    costBasis: 'local',
    trust_mode: 'full',
    provenance: 'provider',
    jurisdiction: 'us',
    capability: { bugfix: 0.8 },
  };
  const lane2: Lane = {
    id: 'lane-2',
    kind: 'api',
    model: 'model-y',
    costBasis: 'local',
    trust_mode: 'full',
    provenance: 'provider',
    jurisdiction: 'us',
    capability: { bugfix: 0.75 },
  };

  const task: Task = { category: 'bugfix' };
  const policy: Policy = { rules: [] };

  const ctx: RouteContext = {
    lanes: [lane1, lane2],
    gateReady: true,
  };

  const decision = routeDecide(task, ctx, policy);

  const expectedMaximized = {
    laneId: 'lane-1',
    reason: 'Selected lane-1 (model-x) for bugfix: capability 0.80 at local cost.',
    scores: [
      {
        laneId: 'lane-1',
        score: 0.8,
        factors: {
          capability: 0.8,
          costPenalty: 0,
          capPenalty: 0,
          declared: 0.8,
          evidenceN: 0
        }
      },
      {
        laneId: 'lane-2',
        score: 0.75,
        factors: {
          capability: 0.75,
          costPenalty: 0,
          capPenalty: 0,
          declared: 0.75,
          evidenceN: 0
        }
      }
    ],
    policyVerdict: 'force-trusted'
  };

  assert.equal(JSON.stringify(decision), JSON.stringify(expectedMaximized));
  assert.deepEqual(decision, expectedMaximized);

  // Also check tiered path
  const ctxTiered: RouteContext = {
    lanes: [lane1, lane2],
    strategy: 'tiered',
    tierFloor: 0.6,
    gateReady: true,
  };

  const decisionTiered = routeDecide(task, ctxTiered, policy);
  const expectedTiered = {
    laneId: 'lane-2',
    reason: 'Selected lane-2 (model-y) for bugfix: cheapest lane clearing the capability floor (tiered), capability 0.75 at local cost.',
    scores: [
      {
        laneId: 'lane-2',
        score: 0.75,
        factors: {
          capability: 0.75,
          costPenalty: 0,
          capPenalty: 0,
          declared: 0.75,
          evidenceN: 0
        }
      },
      {
        laneId: 'lane-1',
        score: 0.8,
        factors: {
          capability: 0.8,
          costPenalty: 0,
          capPenalty: 0,
          declared: 0.8,
          evidenceN: 0
        }
      }
    ],
    policyVerdict: 'force-trusted'
  };

  assert.equal(JSON.stringify(decisionTiered), JSON.stringify(expectedTiered));
  assert.deepEqual(decisionTiered, expectedTiered);
});

test('routing integration: tiered routing ranks healthy lane with cap warning over circuit-open lane', () => {
  const lane1: Lane = { id: 'lane-1', kind: 'api', model: 'model-x', costBasis: 'local', trust_mode: 'full', provenance: 'provider', jurisdiction: 'us', capability: { bugfix: 0.8 } };
  const lane2: Lane = { id: 'lane-2', kind: 'api', model: 'model-y', costBasis: 'local', trust_mode: 'full', provenance: 'provider', jurisdiction: 'us', capability: { bugfix: 0.8 } };

  const task: Task = { category: 'bugfix' };
  const policy: Policy = { rules: [] };

  const ctx: RouteContext = {
    lanes: [lane1, lane2],
    strategy: 'tiered',
    tierFloor: 0.6,
    capHeadroom: { 'lane-1': 0.85, 'lane-2': 1.0 }, // lane-1 has capPenalty = 0.15, lane-2 has capPenalty = 0
    healthPenalty: { 'lane-1': 0, 'lane-2': 1.0 }, // lane-2 is circuit-open
    gateReady: true,
  };

  const decision = routeDecide(task, ctx, policy);
  // Combined depri lane-1: 0.15 + 0 = 0.15.
  // Combined depri lane-2: 0 + 1.0 = 1.0.
  // Lane 1 should win even though it has a cap warning, because Lane 2 is circuit-open.
  assert.equal(decision.laneId, 'lane-1');
});
