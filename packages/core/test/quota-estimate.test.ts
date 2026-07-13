import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCHEMA_VERSION } from '../src/ledger.ts';
import type { LedgerEvent, TaskEvent } from '../src/ledger.ts';
import { quotaEstimate } from '../src/quota.ts';
import type { Lane } from '../src/types.ts';

const NOW = Date.parse('2026-07-11T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let seq = 0;
function taskEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    event_type: 'task',
    schema_version: SCHEMA_VERSION,
    id: `t-${seq}`,
    seq: seq++,
    ts: new Date(NOW - HOUR).toISOString(),
    task_id: `task-${seq}`,
    attempt: 0,
    category: 'bugfix',
    laneId: 'codex-cli',
    model: 'gpt-5.5',
    trust_mode: 'full',
    provenance: 'openai',
    status: 'ok',
    tokens_in: 1000,
    tokens_out: 500,
    tokens_estimated: false,
    actual_cost: 0,
    frontier_cost: 1,
    metered_spent: 0,
    frontier_avoided: 1,
    metered_avoided: 1,
    policy_verdict: 'allow',
    ...overrides,
  };
}

const lane = (over: Partial<Lane> & { id: string }): Lane => ({
  kind: 'cli', model: 'm', trust_mode: 'full', costBasis: 'subscription',
  provenance: 'openai', jurisdiction: 'US', ...over,
});

test('quotaEstimate: no cap configured', () => {
  const l = lane({ id: 'codex-cli' });
  const events = [taskEvent()];
  const est = quotaEstimate(l, events, {}, NOW);
  assert.deepEqual(est, {
    routedFraction: 0,
    lowerBound: 0,
    pointEstimate: 0,
    confidence: 'unknown',
    dominantSource: 'routed',
  });
});

test('quotaEstimate: routed-only (floor, confidence high, dominant routed)', () => {
  // limit 10 requests, 2 events in window -> routed fraction = 0.2
  const l = lane({ id: 'codex-cli', requests_per_window: 10, window_ms: 2 * HOUR });
  const events = [
    taskEvent({ ts: new Date(NOW - 30 * 60 * 1000).toISOString() }),
    taskEvent({ ts: new Date(NOW - 15 * 60 * 1000).toISOString() }),
  ];
  const est = quotaEstimate(l, events, {}, NOW);
  assert.deepEqual(est, {
    routedFraction: 0.2,
    lowerBound: 0.2,
    pointEstimate: 0.2,
    confidence: 'high',
    dominantSource: 'routed',
  });
});

test('quotaEstimate: + calibration (reported point, medium, pointEstimate = max)', () => {
  const l = lane({ id: 'codex-cli', requests_per_window: 10, window_ms: 2 * HOUR });
  const events = [
    taskEvent({ ts: new Date(NOW - 30 * 60 * 1000).toISOString() }),
    taskEvent({ ts: new Date(NOW - 15 * 60 * 1000).toISOString() }),
  ];
  // 1. reported exceeds routed
  const est1 = quotaEstimate(l, events, { calibrationFraction: 0.7 }, NOW);
  assert.deepEqual(est1, {
    routedFraction: 0.2,
    reportedFraction: 0.7,
    lowerBound: 0.7,
    pointEstimate: 0.7,
    confidence: 'medium',
    dominantSource: 'reported',
  });

  // 2. routed exceeds reported
  const est2 = quotaEstimate(l, events, { calibrationFraction: 0.1 }, NOW);
  assert.deepEqual(est2, {
    routedFraction: 0.2,
    reportedFraction: 0.1,
    lowerBound: 0.2,
    pointEstimate: 0.2,
    confidence: 'medium',
    dominantSource: 'routed',
  });
});

test('quotaEstimate: + routed-share (inferred = routed/share clamped, low confidence, dominant inferred when it exceeds)', () => {
  const l = lane({ id: 'codex-cli', requests_per_window: 10, window_ms: 2 * HOUR });
  const events = [
    taskEvent({ ts: new Date(NOW - 30 * 60 * 1000).toISOString() }),
    taskEvent({ ts: new Date(NOW - 15 * 60 * 1000).toISOString() }),
  ];
  // routed = 0.2, routedShare = 0.5 => inferred = 0.4.
  // No calibration. inferred (0.4) > routed (0.2), so dominant inferred, confidence low.
  const est1 = quotaEstimate(l, events, { routedShare: 0.5 }, NOW);
  assert.deepEqual(est1, {
    routedFraction: 0.2,
    inferredFraction: 0.4,
    lowerBound: 0.2,
    pointEstimate: 0.4,
    confidence: 'low',
    dominantSource: 'inferred',
  });

  // routed = 0.2, routedShare = 0.1 => inferred = 2.0 -> clamped to 1.0.
  const est2 = quotaEstimate(l, events, { routedShare: 0.1 }, NOW);
  assert.deepEqual(est2, {
    routedFraction: 0.2,
    inferredFraction: 1.0,
    lowerBound: 0.2,
    pointEstimate: 1.0,
    confidence: 'low',
    dominantSource: 'inferred',
  });

  // routed = 0.2, routedShare = 1.0 => inferred = 0.2.
  // inferred (0.2) is not strictly greater than routed (0.2). Dominant routed, confidence medium.
  const est3 = quotaEstimate(l, events, { routedShare: 1.0 }, NOW);
  assert.deepEqual(est3, {
    routedFraction: 0.2,
    inferredFraction: 0.2,
    lowerBound: 0.2,
    pointEstimate: 0.2,
    confidence: 'medium',
    dominantSource: 'routed',
  });
});

test('quotaEstimate: routedShare edge cases and finite safety', () => {
  const l = lane({ id: 'codex-cli', requests_per_window: 10, window_ms: 2 * HOUR });
  const events = [
    taskEvent({ ts: new Date(NOW - 30 * 60 * 1000).toISOString() }),
    taskEvent({ ts: new Date(NOW - 15 * 60 * 1000).toISOString() }),
  ];

  // invalid/ignored routedShare values: <=0, >1, non-finite
  for (const badShare of [0, -0.5, 1.5, NaN, Infinity, -Infinity]) {
    const est = quotaEstimate(l, events, { routedShare: badShare }, NOW);
    assert.deepEqual(est, {
      routedFraction: 0.2,
      lowerBound: 0.2,
      pointEstimate: 0.2,
      confidence: 'high',
      dominantSource: 'routed',
    });
  }

  // invalid/ignored calibrationFraction values: <0, >1, non-finite
  for (const badCal of [-0.1, 1.1, NaN, Infinity, -Infinity]) {
    const est = quotaEstimate(l, events, { calibrationFraction: badCal }, NOW);
    assert.deepEqual(est, {
      routedFraction: 0.2,
      lowerBound: 0.2,
      pointEstimate: 0.2,
      confidence: 'high',
      dominantSource: 'routed',
    });
  }
});

test('quotaEstimate: tiny quota limit handles non-finite cases safely', () => {
  const tinyLane = lane({ id: 'tiny', requests_per_window: Number.MIN_VALUE, window_ms: 1000 });
  const events = [taskEvent({ laneId: 'tiny', ts: new Date(NOW - 100).toISOString() })];
  // 1 event divided by Number.MIN_VALUE would ordinarily be Infinity.
  // Our finite guard in quotaEstimate clamps/resets it.
  const est = quotaEstimate(tinyLane, events, { calibrationFraction: 0.5, routedShare: 0.5 }, NOW);
  assert.equal(Number.isFinite(est.routedFraction), true);
  assert.equal(Number.isFinite(est.pointEstimate), true);
  assert.equal(Number.isFinite(est.lowerBound), true);
  if (est.reportedFraction !== undefined) {
    assert.equal(Number.isFinite(est.reportedFraction), true);
  }
  if (est.inferredFraction !== undefined) {
    assert.equal(Number.isFinite(est.inferredFraction), true);
  }
  assert.equal(est.routedFraction, 0);
  // Rendered/serialized text must never leak "Infinity"/"NaN". Formatting each
  // field as a percentage is exactly how status/why would render it, so an
  // Infinity/NaN would surface as the literal string here.
  for (const v of [est.routedFraction, est.reportedFraction, est.inferredFraction, est.lowerBound, est.pointEstimate]) {
    if (v === undefined) continue;
    const pct = `${(v * 100).toFixed(0)}%`;
    assert.ok(!pct.includes('Infinity') && !pct.includes('NaN'), `rendered percentage leaked non-finite: ${pct}`);
  }
});
