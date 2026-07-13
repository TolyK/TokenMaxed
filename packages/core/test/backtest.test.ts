import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LedgerEvent, TaskEvent, OutcomeEvent, Lane, RouteContext, Policy, TaskCategory, DifficultyBucket } from '../src/index.ts';
import { analyzeBacktest, routeDecide, observedForLaneWithDifficulty } from '../src/index.ts';

const LANES: Lane[] = [
  {
    id: 'frontier-lane',
    kind: 'api',
    model: 'claude-opus',
    trust_mode: 'full',
    costBasis: 'metered',
    provenance: 'anthropic',
    jurisdiction: 'US',
    capability: { feature: 1.0, bugfix: 1.0 },
  },
  {
    id: 'cheaper-lane',
    kind: 'local',
    model: 'llama3',
    trust_mode: 'full',
    costBasis: 'local',
    provenance: 'meta',
    jurisdiction: 'US',
    capability: { feature: 0.75, bugfix: 0.7 },
  },
];

const POLICY: Policy = {
  rules: [],
};

// Helpers for mock events
function makeTaskEvent(
  id: string,
  seq: number,
  category: TaskCategory,
  status: TaskEvent['status'] = 'ok',
  laneId = 'cheaper-lane'
): TaskEvent {
  return {
    event_type: 'task',
    schema_version: 2,
    id,
    seq,
    ts: new Date().toISOString(),
    task_id: id,
    attempt: 0,
    category,
    laneId,
    model: 'llama3',
    trust_mode: 'full',
    provenance: 'meta',
    status,
    tokens_in: 100,
    tokens_out: 50,
    tokens_estimated: false,
    actual_cost: 0,
    frontier_cost: 0.01,
    metered_spent: 0,
    frontier_avoided: 0.01,
    metered_avoided: 0.01,
    policy_verdict: 'allow',
  };
}

function makeOutcomeEvent(
  taskId: string,
  seq: number,
  category: TaskCategory,
  verdict: 'pass' | 'needs-rework' | 'fail',
  laneId: string,
  difficulty?: 'easy' | 'moderate' | 'hard'
): OutcomeEvent {
  return {
    event_type: 'outcome',
    schema_version: 2,
    id: `outcome-${taskId}`,
    seq,
    ts: new Date().toISOString(),
    subject_id: taskId,
    subject_type: 'router_task',
    task_id: taskId,
    review_id: `rev-${taskId}`,
    attempt: 0,
    category,
    subject_lane_id: laneId,
    subject_model: laneId === 'frontier-lane' ? 'claude-opus' : 'llama3',
    reviewer_lane_id: 'host',
    reviewer_model: 'host',
    reviewer_trust_mode: 'full',
    reviewer_provenance: 'host',
    verdict,
    voter: 'user',
    policy_verdict: 'allow',
    ...(difficulty ? { difficulty } : {}),
  };
}

test('analyzeBacktest parses workload and detects differences', () => {
  const events: LedgerEvent[] = [
    makeTaskEvent('t1', 1, 'feature'),
    makeTaskEvent('t2', 2, 'feature'),
    makeTaskEvent('t3', 3, 'bugfix'),
  ];

  const baseCtx: RouteContext = {
    lanes: LANES,
    gateReady: true,
    observedCapability: {},
  };

  const result = analyzeBacktest(events, baseCtx, POLICY, Date.now(), {
    policyA: 'balanced',
    policyB: 'cheapest',
  });

  assert.equal(result.diffPercent, 100);
  assert.equal(result.differences.length, 2);

  const featureDiff = result.differences.find((d) => d.category === 'feature');
  assert.ok(featureDiff);
  assert.equal(featureDiff!.workloadSharePercent, (2 / 3) * 100);
  assert.equal(featureDiff!.pickA, 'frontier-lane');
  assert.equal(featureDiff!.pickB, 'cheaper-lane');
  assert.equal(featureDiff!.comparison, 'insufficient_evidence');
});

test('analyzeBacktest quality proxy handles observed overlays and Wilson intervals', () => {
  const events: LedgerEvent[] = [
    makeTaskEvent('t1', 1, 'feature'),
  ];

  for (let i = 0; i < 10; i++) {
    events.push(makeOutcomeEvent(`t-frontier-${i}`, 10 + i, 'feature', 'pass', 'frontier-lane'));
  }
  for (let i = 0; i < 10; i++) {
    events.push(makeOutcomeEvent(`t-cheaper-${i}`, 20 + i, 'feature', 'fail', 'cheaper-lane'));
  }

  const baseCtx: RouteContext = {
    lanes: LANES,
    gateReady: true,
    tierFloor: 0.2,
    observedCapabilityByModel: {
      'claude-opus': {
        feature: { rate: 1.0, n: 10 },
      },
      'llama3': {
        feature: { rate: 0.0, n: 10 },
      },
    },
  };

  const result = analyzeBacktest(events, baseCtx, POLICY, Date.now(), {
    policyA: 'balanced',
    policyB: 'cheapest',
  });

  const diff = result.differences.find((d) => d.category === 'feature');
  assert.ok(diff);
  assert.equal(diff!.comparison, 'favors_A');
  assert.equal(result.netSignal, 'evidence favors A');
  assert.ok(diff!.evidenceA);
  assert.ok(diff!.evidenceB);
  assert.equal(diff!.evidenceA!.rate, 1.0);
  assert.equal(diff!.evidenceB!.rate, 0.0);
});

test('analyzeBacktest invalid-number containment', () => {
  const events = [makeTaskEvent('t1', 1, 'feature')];
  const baseCtx: RouteContext = {
    lanes: LANES,
    gateReady: true,
    observedCapabilityByModel: {
      'claude-opus': {
        feature: { rate: NaN, n: 10 },
      },
      'llama3': {
        feature: { rate: 0.8, n: -5 },
      },
    },
  };
  const result = analyzeBacktest(events, baseCtx, POLICY, Date.now(), {
    policyA: 'balanced',
    policyB: 'cheapest',
  });
  const diff = result.differences[0];
  assert.ok(diff);
  assert.equal(diff.comparison, 'insufficient_evidence');
  assert.equal(diff.evidenceA, undefined);
  assert.equal(diff.evidenceB, undefined);
});

test('analyzeBacktest policy-order invariance and tier-floor parity', () => {
  const events = [makeTaskEvent('t1', 1, 'feature')];
  const baseCtxWithHighFloor: RouteContext = {
    lanes: LANES,
    gateReady: true,
    tierFloor: 0.9,
  };
  const resultAB = analyzeBacktest(events, baseCtxWithHighFloor, POLICY, Date.now(), {
    policyA: 'balanced',
    policyB: 'cheapest',
  });
  const resultBA = analyzeBacktest(events, baseCtxWithHighFloor, POLICY, Date.now(), {
    policyA: 'cheapest',
    policyB: 'balanced',
  });
  assert.equal(resultAB.differences.length, 0);
  assert.equal(resultBA.differences.length, 0);

  const baseCtxWithLowFloor: RouteContext = {
    lanes: LANES,
    gateReady: true,
    tierFloor: 0.2,
  };
  const diffAB = analyzeBacktest(events, baseCtxWithLowFloor, POLICY, Date.now(), {
    policyA: 'balanced',
    policyB: 'cheapest',
  });
  const diffBA = analyzeBacktest(events, baseCtxWithLowFloor, POLICY, Date.now(), {
    policyA: 'cheapest',
    policyB: 'balanced',
  });
  assert.equal(diffAB.differences.length, 1);
  assert.equal(diffBA.differences.length, 1);
  assert.equal(diffAB.diffPercent, 100);
  assert.equal(diffBA.diffPercent, 100);
  assert.equal(diffAB.differences[0]!.pickA, 'frontier-lane');
  assert.equal(diffAB.differences[0]!.pickB, 'cheaper-lane');
  assert.equal(diffBA.differences[0]!.pickA, 'cheaper-lane');
  assert.equal(diffBA.differences[0]!.pickB, 'frontier-lane');
});

test('analyzeBacktest difficulty-conditioned evidence matches replayed cell', () => {
  const events: LedgerEvent[] = [
    makeTaskEvent('t1', 1, 'feature'),
    makeOutcomeEvent('t1', 2, 'feature', 'pass', 'cheaper-lane', 'hard'),
  ];
  const baseCtx: RouteContext = {
    lanes: LANES,
    gateReady: true,
    tierFloor: 0.2,
    observedCapabilityByModelDifficulty: {
      'claude-opus': {
        feature: {
          hard: { rate: 1.0, n: 10 },
        },
      },
      'llama3': {
        feature: {
          hard: { rate: 0.0, n: 10 },
        },
      },
    },
  };
  const result = analyzeBacktest(events, baseCtx, POLICY, Date.now(), {
    policyA: 'balanced',
    policyB: 'cheapest',
  });
  const diff = result.differences.find((d) => d.category === 'feature');
  assert.ok(diff);
  assert.equal(diff!.difficulty, 'hard');
  assert.ok(diff!.evidenceA);
  assert.equal(diff!.evidenceA!.rate, 1.0);
  assert.equal(diff!.evidenceA!.n, 10);
  assert.ok(diff!.evidenceB);
  assert.equal(diff!.evidenceB!.rate, 0.0);
  assert.equal(diff!.evidenceB!.n, 10);
  assert.equal(diff!.comparison, 'favors_A');
});

test('analyzeBacktest respects availableLaneIds in baseCtx', () => {
  const events = [makeTaskEvent('t1', 1, 'feature')];
  const baseCtx: RouteContext = {
    lanes: LANES,
    gateReady: true,
    tierFloor: 0.2,
    availableLaneIds: ['frontier-lane'],
  };
  const result = analyzeBacktest(events, baseCtx, POLICY, Date.now(), {
    policyA: 'balanced',
    policyB: 'cheapest',
  });
  assert.equal(result.differences.length, 0);
});

test('analyzeBacktest output is count-free (routed-share-only)', () => {
  const events = [
    makeTaskEvent('t1', 1, 'feature'),
    makeTaskEvent('t2', 2, 'feature'),
  ];
  const baseCtx: RouteContext = {
    lanes: LANES,
    gateReady: true,
    tierFloor: 0.2,
  };
  const result = analyzeBacktest(events, baseCtx, POLICY, Date.now(), {
    policyA: 'balanced',
    policyB: 'cheapest',
  });
  const keys = Object.keys(result);
  assert.ok(!keys.includes('totalDecisions'));
  assert.ok(!keys.includes('diffCount'));
  assert.equal(result.diffPercent, 100);

  const diffKeys = Object.keys(result.differences[0] || {});
  assert.ok(!diffKeys.includes('volume'));
  assert.equal(result.differences[0]?.workloadSharePercent, 100);
});

test('analyzeBacktest coverage-weighted aggregate remains neutral on low coverage', () => {
  const events: LedgerEvent[] = [
    makeTaskEvent('t-feat', 1, 'feature'),
    ...Array.from({ length: 9 }, (_, i) => makeTaskEvent(`t-bug-${i}`, 10 + i, 'bugfix')),
  ];

  // Sufficient evidence for BOTH feature lanes
  for (let i = 0; i < 10; i++) {
    events.push(makeOutcomeEvent(`t-feat-out-front-${i}`, 100 + i, 'feature', 'pass', 'frontier-lane'));
    events.push(makeOutcomeEvent(`t-feat-out-cheap-${i}`, 200 + i, 'feature', 'fail', 'cheaper-lane'));
  }

  const baseCtx: RouteContext = {
    lanes: LANES,
    gateReady: true,
    tierFloor: 0.2,
    observedCapabilityByModel: {
      'claude-opus': {
        feature: { rate: 1.0, n: 10 },
      },
      'llama3': {
        feature: { rate: 0.0, n: 10 },
      },
    },
  };

  const result = analyzeBacktest(events, baseCtx, POLICY, Date.now(), {
    policyA: 'balanced',
    policyB: 'cheapest',
  });

  const featDiff = result.differences.find((d) => d.category === 'feature');
  assert.ok(featDiff);
  assert.equal(featDiff!.comparison, 'favors_A');

  // Aggregate netSignal must remain neutral because 90% of differing volume is insufficient evidence
  assert.equal(result.netSignal, 'neutral / insufficient');
});

test('analyzeBacktest difficulty backoff precedence parity with routeDecide', () => {
  const task: { category: TaskCategory; difficulty: DifficultyBucket } = {
    category: 'feature',
    difficulty: 'hard',
  };

  // Branch (a): difficulty -> category backoff (difficulty hard misses exact difficulty overlay)
  const baseCtxA: RouteContext = {
    lanes: LANES,
    gateReady: true,
    tierFloor: 0.2,
    observedCapability: {
      'frontier-lane': { feature: { rate: 1.0, n: 10 } },
      'cheaper-lane': { feature: { rate: 0.0, n: 10 } },
    },
    observedCapabilityByModel: {
      'claude-opus': { feature: { rate: 0.9, n: 8 } },
      'llama3': { feature: { rate: 0.1, n: 8 } },
    },
    observedCapabilityByModelDifficulty: {
      'claude-opus': { feature: { easy: { rate: 0.95, n: 5 } } },
      'llama3': { feature: { easy: { rate: 0.05, n: 5 } } },
    },
  };

  // Run the quality proxy lookup
  const obsA = observedForLaneWithDifficulty(
    LANES[0]!,
    task.category,
    task.difficulty,
    baseCtxA.observedCapability,
    baseCtxA.observedCapabilityByModel,
    baseCtxA.observedCapabilityByModelDifficulty
  );
  assert.ok(obsA);
  // Must back off to category level modelOverlay: { rate: 0.9, n: 8 }
  assert.equal(obsA!.rate, 0.9);
  assert.equal(obsA!.n, 8);

  // Run routeDecide under the same context
  const decisionA = routeDecide(task, baseCtxA, POLICY);
  const scoreA = decisionA.scores.find((s) => s.laneId === 'frontier-lane');
  assert.ok(scoreA);
  // routeDecide must have consulted the category-level modelOverlay cell
  assert.equal(scoreA!.factors.evidenceN, 8);

  // Assert that if the backtest had incorrectly used the difficulty overlay cell (easy) or lane overlay (n=10),
  // it would diverge from the consulted cell.
  assert.notEqual(obsA!.n, 5);
  assert.notEqual(obsA!.n, 10);


  // Branch (b): category -> declared/prior backoff (no observed cell at all)
  const baseCtxB: RouteContext = {
    lanes: LANES,
    gateReady: true,
    tierFloor: 0.2,
    observedCapability: {
      'frontier-lane': { feature: { rate: 1.0, n: 10 } },
    },
    // Model overlay exists but lacks category cell
    observedCapabilityByModel: {
      'claude-opus': {},
    },
  };

  const obsB = observedForLaneWithDifficulty(
    LANES[0]!,
    task.category,
    task.difficulty,
    baseCtxB.observedCapability,
    baseCtxB.observedCapabilityByModel,
    baseCtxB.observedCapabilityByModelDifficulty
  );
  // Because modelOverlay is present, it does NOT fall back to lane overlay => returns undefined
  assert.equal(obsB, undefined);

  // Run routeDecide under same context
  const decisionB = routeDecide(task, baseCtxB, POLICY);
  const scoreB = decisionB.scores.find((s) => s.laneId === 'frontier-lane');
  assert.ok(scoreB);
  // routeDecide must have used declared/prior capability with n = 0
  assert.equal(scoreB!.factors.evidenceN, 0);
  assert.equal(scoreB!.factors.capability, scoreB!.factors.declared);
});
