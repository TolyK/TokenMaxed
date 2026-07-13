import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LedgerEvent, Lane, PriceTable } from '../src/index.ts';
import { analyzePlan } from '../src/index.ts';

const TABLE: PriceTable = {
  schema_version: 1,
  frontier_model: 'claude-opus-4-7',
  models: {
    'claude-opus-4-7': { inputPer1M: 15, outputPer1M: 75 },
    'gpt-5.5': { inputPer1M: 10, outputPer1M: 100 },
    'claude-haiku': { inputPer1M: 0.25, outputPer1M: 1.25 },
    'llama3': { inputPer1M: 0, outputPer1M: 0 },
  },
};

const LANES: Lane[] = [
  {
    id: 'frontier-lane',
    kind: 'api',
    model: 'claude-opus-4-7',
    trust_mode: 'full',
    costBasis: 'metered',
    provenance: 'anthropic',
    jurisdiction: 'US',
    capability: { feature: 1.0, bugfix: 0.9, codegen: 0.8 },
  },
  {
    id: 'underused-lane',
    kind: 'cli',
    model: 'claude-haiku',
    trust_mode: 'full',
    costBasis: 'subscription',
    provenance: 'anthropic',
    jurisdiction: 'US',
    capability: { boilerplate: 0.9 },
  },
  {
    id: 'cheaper-lane',
    kind: 'local',
    model: 'llama3',
    trust_mode: 'full',
    costBasis: 'local',
    provenance: 'meta',
    jurisdiction: 'US',
    capability: { feature: 0.85, bugfix: 0.85 },
  },
  {
    id: 'metered-lane',
    kind: 'api',
    model: 'gpt-5.5',
    trust_mode: 'full',
    costBasis: 'metered',
    provenance: 'openai',
    jurisdiction: 'US',
    capability: { feature: 0.9 },
  },
];

// Helper to make a mock TaskEvent
function makeTaskEvent(
  id: string,
  seq: number,
  laneId: string,
  model: string,
  category: string,
  status: string,
  meteredSpent: number,
  tokensIn = 1000,
  tokensOut = 500
): LedgerEvent {
  return {
    event_type: 'task',
    schema_version: 2,
    id,
    seq,
    ts: new Date().toISOString(),
    task_id: id,
    attempt: 0,
    category: category as any,
    laneId,
    model,
    trust_mode: 'full',
    provenance: 'unknown',
    status: status as any,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    tokens_estimated: false,
    actual_cost: meteredSpent,
    frontier_cost: 0.05,
    metered_spent: meteredSpent,
    frontier_avoided: 0.05 - meteredSpent,
    metered_avoided: 0.05 - meteredSpent,
    policy_verdict: 'allow',
  };
}

test('analyzePlan computes stats correctly and fires appropriate suggestions', () => {
  const events: LedgerEvent[] = [
    // 9 features on frontier
    ...Array.from({ length: 9 }, (_, i) => makeTaskEvent(`t-${i}`, i, 'frontier-lane', 'claude-opus-4-7', 'feature', 'ok', 0.5)),
    // 1 boilerplate on underused
    makeTaskEvent('t-9', 9, 'underused-lane', 'claude-haiku', 'boilerplate', 'ok', 0),
    // 1 bugfix on metered-lane
    makeTaskEvent('t-10', 10, 'metered-lane', 'gpt-5.5', 'bugfix', 'ok', 0.2),
  ];

  const result = analyzePlan(events, LANES, TABLE, Date.now(), { periodLabel: 'last 7d' });

  assert.equal(result.totalRoutedOffloads, 11);
  assert.equal(result.message, undefined);

  // Verify laneStats
  const frontierStats = result.laneStats['frontier-lane']!;
  assert.equal(frontierStats.deliveredCount, 9);
  assert.equal(frontierStats.routedCount, 9);
  assert.equal(Math.abs(frontierStats.share - (100 * 9 / 11)) < 1e-5, true);
  assert.equal(frontierStats.meteredSpent, 4.5);
  assert.equal(frontierStats.categoryDistribution['feature'], 9);

  const underusedStats = result.laneStats['underused-lane']!;
  assert.equal(underusedStats.deliveredCount, 1);
  assert.equal(underusedStats.share < 10, true); // 1/11 ~ 9% < 10%

  // Verify suggestions
  assert.ok(result.suggestions.length > 0);

  // 1. Underused lane suggestion should fire
  const underusedSug = result.suggestions.find(s => s.title.includes('underused-lane') || s.title.includes('Underused lane: underused-lane'));
  assert.ok(underusedSug);
  assert.match(underusedSug.evidence, /routed-share/);
  assert.match(underusedSug.evidence, /lane underused-lane handled 1 of your 11 routed attempts/);
  assert.doesNotMatch(underusedSug.suggestion, /\$/); // No fabricated dollar savings/costs

  // 2. Frontier conservation suggestion should fire (feature constitutes 100% of frontier tasks, cheaper-lane is capable)
  const conservationSug = result.suggestions.find(s => s.title.includes('Frontier-conservation: frontier-lane (feature)'));
  assert.ok(conservationSug);
  assert.match(conservationSug.evidence, /routed-share/);
  assert.match(conservationSug.suggestion, /routing category feature to cheaper-lane would ease pressure on frontier-lane/);

  // 3. Metered spend suggestion should fire for metered-lane and frontier-lane
  const meteredSug = result.suggestions.find(s => s.title.includes('Metered spend: metered-lane'));
  assert.ok(meteredSug);
  assert.match(meteredSug.evidence, /you spent \$0.2000 metered on lane metered-lane/);
  assert.match(meteredSug.evidence, /routed-share/);
  assert.match(meteredSug.suggestion, /Consider routing these tasks to a subscription or local lane/);
});

test('analyzePlan handles empty/sparse ledger gracefully', () => {
  const resultEmpty = analyzePlan([], LANES, TABLE, Date.now());
  assert.equal(resultEmpty.totalRoutedOffloads, 0);
  assert.equal(resultEmpty.message, 'not enough routed history to advise yet (need more offloads)');
  assert.equal(resultEmpty.suggestions.length, 0);

  const sparseEvents = [
    makeTaskEvent('t-0', 0, 'frontier-lane', 'claude-opus-4-7', 'feature', 'ok', 0.5),
  ];
  const resultSparse = analyzePlan(sparseEvents, LANES, TABLE, Date.now());
  assert.equal(resultSparse.totalRoutedOffloads, 1);
  assert.equal(resultSparse.message, 'not enough routed history to advise yet (need more offloads)');
  assert.equal(resultSparse.suggestions.length, 0);
});

test('analyzePlan checks that no plan cost or dollar savings are fabricated', () => {
  const events: LedgerEvent[] = [
    ...Array.from({ length: 9 }, (_, i) => makeTaskEvent(`t-${i}`, i, 'frontier-lane', 'claude-opus-4-7', 'feature', 'ok', 0.5)),
    makeTaskEvent('t-9', 9, 'underused-lane', 'claude-haiku', 'boilerplate', 'ok', 0),
    makeTaskEvent('t-10', 10, 'metered-lane', 'gpt-5.5', 'bugfix', 'ok', 0.2),
  ];

  const result = analyzePlan(events, LANES, TABLE, Date.now());
  for (const s of result.suggestions) {
    if (s.title.includes('Underused')) {
      assert.doesNotMatch(s.evidence, /\$/);
      assert.doesNotMatch(s.suggestion, /\$/);
    }
    if (s.title.includes('Frontier-conservation')) {
      assert.doesNotMatch(s.evidence, /\$/);
      assert.doesNotMatch(s.suggestion, /\$/);
    }
    if (s.title.includes('Metered spend')) {
      assert.match(s.evidence, /\$\d+\.\d+/);
      assert.doesNotMatch(s.suggestion, /\$/);
    }
  }
});

test('analyzePlan handles non-finite metered spend safely', () => {
  const events: LedgerEvent[] = [
    ...Array.from({ length: 9 }, (_, i) => makeTaskEvent(`t-${i}`, i, 'frontier-lane', 'claude-opus-4-7', 'feature', 'ok', 0.5)),
    makeTaskEvent('t-9', 9, 'metered-lane', 'gpt-5.5', 'feature', 'ok', Infinity),
  ];

  const result = analyzePlan(events, LANES, TABLE, Date.now());
  const meteredStats = result.laneStats['metered-lane']!;
  assert.equal(meteredStats.meteredSpentUnavailable, true);
  assert.equal(meteredStats.meteredSpent, null); // structured meteredSpent must be null (FIX 1)

  const suggestion = result.suggestions.find(s => s.title.includes('Metered spend: metered-lane'));
  assert.ok(suggestion);
  assert.match(suggestion.evidence, /metered spend unavailable — data anomaly/);
  assert.doesNotMatch(suggestion.evidence, /\$/);
});

test('analyzePlan compares metered lanes based on observed category token mix', () => {
  const events: LedgerEvent[] = [
    ...Array.from({ length: 9 }, (_, i) => makeTaskEvent(`t-${i}`, i, 'frontier-lane', 'claude-opus-4-7', 'feature', 'ok', 0.5, 1000, 5)),
    makeTaskEvent('t-9', 9, 'underused-lane', 'claude-haiku', 'boilerplate', 'ok', 0),
  ];

  const result = analyzePlan(events, LANES, TABLE, Date.now());
  const sug = result.suggestions.find(s => s.title.includes('Frontier-conservation: frontier-lane (feature)') && s.evidence.includes('metered-lane'));
  assert.ok(sug);
  assert.match(sug.evidence, /lane metered-lane is capable/);
});

test('regression: 10-failed-of-15 gives routed share 66.7% and no underuse suggestion', () => {
  const events: LedgerEvent[] = [
    // 5 delivered successes on frontier-lane
    ...Array.from({ length: 5 }, (_, i) => makeTaskEvent(`t-${i}`, i, 'frontier-lane', 'claude-opus-4-7', 'feature', 'ok', 0.5)),
    // 10 failed tasks on metered-lane
    ...Array.from({ length: 10 }, (_, i) => makeTaskEvent(`tf-${i}`, 5 + i, 'metered-lane', 'gpt-5.5', 'bugfix', 'fail', 0.2)),
  ];

  const result = analyzePlan(events, LANES, TABLE, Date.now());
  assert.equal(result.totalRoutedOffloads, 15);

  const meteredStats = result.laneStats['metered-lane']!;
  assert.equal(meteredStats.deliveredCount, 0); // 0 successes
  assert.equal(meteredStats.routedCount, 10); // 10 routed attempts
  assert.equal(Math.abs(meteredStats.share - 66.7) < 0.1, true); // ~66.7% share

  // Underuse suggestion threshold is < 10%. With 66.7%, metered-lane is NOT underused!
  const underusedSug = result.suggestions.find(s => s.title.includes('Underused lane: metered-lane'));
  assert.equal(underusedSug, undefined);
});

test('regression: two frontier lanes attributed correctly', () => {
  const customLanes: Lane[] = [
    {
      id: 'frontier-1',
      kind: 'api',
      model: 'claude-opus-4-7',
      trust_mode: 'full',
      costBasis: 'metered',
      provenance: 'anthropic',
      jurisdiction: 'US',
      capability: { feature: 1.0 },
    },
    {
      id: 'frontier-2',
      kind: 'api',
      model: 'claude-opus-4-7',
      trust_mode: 'full',
      costBasis: 'metered',
      provenance: 'anthropic',
      jurisdiction: 'US',
      capability: { feature: 1.0 },
    },
    {
      id: 'cheaper-lane',
      kind: 'local',
      model: 'llama3',
      trust_mode: 'full',
      costBasis: 'local',
      provenance: 'meta',
      jurisdiction: 'US',
      capability: { feature: 0.9 },
    },
  ];

  const events: LedgerEvent[] = [
    // 1 task on frontier-1
    makeTaskEvent('t-0', 0, 'frontier-1', 'claude-opus-4-7', 'feature', 'ok', 0.5),
    // 9 tasks on frontier-2
    ...Array.from({ length: 9 }, (_, i) => makeTaskEvent(`t-${i+1}`, i+1, 'frontier-2', 'claude-opus-4-7', 'feature', 'ok', 0.5)),
  ];

  const result = analyzePlan(events, customLanes, TABLE, Date.now());

  // Check stats
  assert.equal(result.laneStats['frontier-1']!.routedCount, 1);
  assert.equal(result.laneStats['frontier-2']!.routedCount, 9);

  // Check category breakdown per frontier lane is attributed correctly (FIX 6)
  assert.equal(result.frontierCategoryBreakdown['frontier-1']!['feature'], 1);
  assert.equal(result.frontierCategoryBreakdown['frontier-2']!['feature'], 9);

  // Suggestions should fire for each frontier lane individually with correct counts
  const sug1 = result.suggestions.find(s => s.title.includes('Frontier-conservation: frontier-1'));
  const sug2 = result.suggestions.find(s => s.title.includes('Frontier-conservation: frontier-2'));

  assert.ok(sug1);
  assert.ok(sug2);
  assert.match(sug1.evidence, /frontier-1's routed attempts \(1 of 1 routed attempts\)/);
  assert.match(sug2.evidence, /frontier-2's routed attempts \(9 of 9 routed attempts\)/);
});

test('regression: historical (removed) lane is statistical-only', () => {
  const activeLanes: Lane[] = [
    {
      id: 'active-frontier',
      kind: 'api',
      model: 'claude-opus-4-7',
      trust_mode: 'full',
      costBasis: 'metered',
      provenance: 'anthropic',
      jurisdiction: 'US',
      capability: { feature: 1.0 },
    },
  ];

  const events: LedgerEvent[] = [
    // 5 tasks on active-frontier
    ...Array.from({ length: 5 }, (_, i) => makeTaskEvent(`t-${i}`, i, 'active-frontier', 'claude-opus-4-7', 'feature', 'ok', 0.5)),
    // 1 task on historical-lane (not in activeLanes)
    makeTaskEvent('h-1', 5, 'historical-lane', 'gpt-5.5', 'bugfix', 'ok', 0.2),
  ];

  const result = analyzePlan(events, activeLanes, TABLE, Date.now());

  // Historical lane must be present in stats
  assert.ok(result.laneStats['historical-lane']);
  assert.equal(result.laneStats['historical-lane']!.routedCount, 1);

  // Historical lane must NOT generate underused or metered spend suggestions
  const underusedSug = result.suggestions.find(s => s.title.includes('historical-lane'));
  const spendSug = result.suggestions.find(s => s.title.includes('historical-lane'));

  assert.equal(underusedSug, undefined);
  assert.equal(spendSug, undefined);
});
