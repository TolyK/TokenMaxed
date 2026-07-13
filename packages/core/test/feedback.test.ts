/**
 * F1-S2 — pure decayed outcome aggregator (`outcomeCapability`). Covers the
 * filters, de-dup, recency decay, and timestamp/option edge cases the overlay
 * must respect. Relative source import (no-build test rule).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_HALF_LIFE_DAYS, outcomeCapability } from '../src/feedback.ts';
import { SCHEMA_VERSION } from '../src/ledger.ts';
import type { LedgerEvent, OutcomeEvent, TaskEvent } from '../src/ledger.ts';

const MS_PER_DAY = 86_400_000;
const NOW = Date.parse('2026-06-02T00:00:00.000Z');
const MODEL = 'gpt-5-codex';

/** ISO timestamp `days` before NOW (negative ⇒ in the future). */
function isoDaysAgo(days: number): string {
  return new Date(NOW - days * MS_PER_DAY).toISOString();
}

let seq = 0;
function outcome(overrides: Partial<OutcomeEvent> = {}): OutcomeEvent {
  return {
    event_type: 'outcome',
    schema_version: SCHEMA_VERSION,
    id: `o-${seq}`,
    seq: seq++,
    ts: isoDaysAgo(0),
    subject_id: 't-0',
    subject_type: 'router_task',
    task_id: 't-0',
    review_id: 'r-0',
    attempt: 0,
    category: 'bugfix',
    subject_lane_id: 'codex-cli',
    subject_provenance: 'openai',
    subject_model: MODEL,
    subject_model_resolved: MODEL,
    reviewer_lane_id: 'claude-native',
    reviewer_model: 'claude-opus-4-7',
    reviewer_trust_mode: 'full',
    reviewer_provenance: 'anthropic',
    verdict: 'pass',
    voter: 'reviewer_model',
    policy_verdict: 'allow',
    ...overrides,
  };
}

function near(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} ≈ ${expected}`);
}

test('no events yields an empty overlay', () => {
  assert.equal(Object.keys(outcomeCapability([], NOW)).length, 0);
});

test('a single fresh pass gives rate 1 and n 1', () => {
  const o = outcomeCapability([outcome({ verdict: 'pass' })], NOW);
  near(o[MODEL]!.bugfix!.rate, 1);
  near(o[MODEL]!.bugfix!.n, 1);
});

test('verdicts map onto the dogfood scale (pass=1, needs-rework=½, fail=0)', () => {
  const events: LedgerEvent[] = [
    outcome({ task_id: 'a', subject_id: 'a', verdict: 'pass' }),
    outcome({ task_id: 'b', subject_id: 'b', verdict: 'needs-rework' }),
    outcome({ task_id: 'c', subject_id: 'c', verdict: 'fail' }),
  ];
  const o = outcomeCapability(events, NOW);
  near(o[MODEL]!.bugfix!.rate, (1 + 0.5 + 0) / 3);
  near(o[MODEL]!.bugfix!.n, 3);
});

test('recency decay: an outcome one half-life old weighs half a fresh one', () => {
  const events: LedgerEvent[] = [
    outcome({ task_id: 'fresh', subject_id: 'fresh', ts: isoDaysAgo(0), verdict: 'pass' }),
    outcome({ task_id: 'old', subject_id: 'old', ts: isoDaysAgo(DEFAULT_HALF_LIFE_DAYS), verdict: 'fail' }),
  ];
  const o = outcomeCapability(events, NOW);
  // fresh: weight 1 value 1; old: weight 0.5 value 0 ⇒ rate = 1/1.5, n = 1.5
  near(o[MODEL]!.bugfix!.rate, 1 / 1.5);
  near(o[MODEL]!.bugfix!.n, 1.5);
});

test('de-dup: only the latest (max seq) outcome per (task,attempt,model,category) counts', () => {
  const events: LedgerEvent[] = [
    outcome({ seq: 1, verdict: 'fail' }), // earlier review of the same attempt
    outcome({ seq: 5, verdict: 'pass' }), // latest review wins
  ];
  const o = outcomeCapability(events, NOW);
  near(o[MODEL]!.bugfix!.rate, 1); // pass, not the fail
  near(o[MODEL]!.bugfix!.n, 1); // counted once, not twice
});

test('unattributed / host-turn / task events are excluded, but user feedback is included', () => {
  const taskEvent = { event_type: 'task' } as unknown as TaskEvent;
  const events: LedgerEvent[] = [
    outcome({ subject_id: 'h', subject_type: 'host_turn', task_id: undefined, turn_id: 'x', subject_lane_id: undefined }),
    outcome({ task_id: 'n', subject_id: 'n', subject_lane_id: undefined }), // unattributed
    outcome({ task_id: undefined, subject_id: 'z' }), // no task_id
    taskEvent,
  ];
  assert.equal(Object.keys(outcomeCapability(events, NOW)).length, 0);

  const userEvents: LedgerEvent[] = [
    outcome({ task_id: 'u', subject_id: 'u', voter: 'user', verdict: 'fail' }),
  ];
  const o = outcomeCapability(userEvents, NOW);
  assert.equal(o[MODEL]!.bugfix!.rate, 0);
  assert.equal(o[MODEL]!.bugfix!.n, 1);
});

test('future-dated outcomes are clamped to age 0 (weight ≤ 1, never amplified)', () => {
  const o = outcomeCapability([outcome({ ts: isoDaysAgo(-100), verdict: 'pass' })], NOW);
  near(o[MODEL]!.bugfix!.n, 1); // weight 1, not >1
});

test('outcomes with an unparseable timestamp are dropped', () => {
  assert.equal(Object.keys(outcomeCapability([outcome({ ts: 'not-a-date' })], NOW)).length, 0);
});

test('invalid halfLifeDays falls back to the default', () => {
  const events: LedgerEvent[] = [outcome({ ts: isoDaysAgo(DEFAULT_HALF_LIFE_DAYS), verdict: 'pass' })];
  const expected = outcomeCapability(events, NOW); // default
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const got = outcomeCapability(events, NOW, { halfLifeDays: bad });
    near(got[MODEL]!.bugfix!.n, expected[MODEL]!.bugfix!.n);
  }
});

test('models and categories are aggregated independently', () => {
  const events: LedgerEvent[] = [
    outcome({ task_id: 'a', subject_id: 'a', subject_model: 'model-a', subject_model_resolved: 'model-a', category: 'bugfix', verdict: 'pass' }),
    outcome({ task_id: 'b', subject_id: 'b', subject_model: 'model-a', subject_model_resolved: 'model-a', category: 'docs', verdict: 'fail' }),
    outcome({ task_id: 'c', subject_id: 'c', subject_model: 'model-b', subject_model_resolved: 'model-b', category: 'bugfix', verdict: 'needs-rework' }),
  ];
  const o = outcomeCapability(events, NOW);
  near(o['model-a']!.bugfix!.rate, 1);
  near(o['model-a']!.docs!.rate, 0);
  near(o['model-b']!.bugfix!.rate, 0.5);
  assert.equal(o['model-b']!.docs, undefined);
});

// --- P6 Phase 1c: model-keyed learning ----------------------------------------

test('verdicts for the same model across different lanes aggregate together', () => {
  const events: LedgerEvent[] = [
    outcome({ task_id: 'a', subject_id: 'a', subject_lane_id: 'lane-a', subject_model: 'shared-m', subject_model_resolved: 'shared-m', verdict: 'pass' }),
    outcome({ task_id: 'b', subject_id: 'b', subject_lane_id: 'lane-b', subject_model: 'shared-m', subject_model_resolved: 'shared-m', verdict: 'fail' }),
  ];
  const o = outcomeCapability(events, NOW);
  near(o['shared-m']!.bugfix!.rate, 0.5);
  near(o['shared-m']!.bugfix!.n, 2);
  assert.equal(o['lane-a'], undefined);
  assert.equal(o['lane-b'], undefined);
});

test('verdicts for different models stay separate', () => {
  const events: LedgerEvent[] = [
    outcome({ task_id: 'a', subject_id: 'a', subject_model: 'model-x', subject_model_resolved: 'model-x', verdict: 'pass' }),
    outcome({ task_id: 'b', subject_id: 'b', subject_model: 'model-y', subject_model_resolved: 'model-y', verdict: 'fail' }),
  ];
  const o = outcomeCapability(events, NOW);
  near(o['model-x']!.bugfix!.rate, 1);
  near(o['model-y']!.bugfix!.rate, 0);
});

test('legacy outcomes without subject_model are excluded from model-keyed learning', () => {
  const events: LedgerEvent[] = [
    outcome({ task_id: 'legacy', subject_id: 'legacy', subject_model: undefined, subject_model_resolved: undefined, verdict: 'pass' }),
    outcome({ task_id: 'modern', subject_id: 'modern', subject_model: 'modern-m', subject_model_resolved: 'modern-m', verdict: 'pass' }),
  ];
  const o = outcomeCapability(events, NOW);
  assert.equal(Object.keys(o).length, 1);
  near(o['modern-m']!.bugfix!.rate, 1);
});

test('subject_model_resolved is preferred over subject_model for the key', () => {
  const events: LedgerEvent[] = [
    outcome({
      task_id: 'a',
      subject_id: 'a',
      subject_model: 'raw-alias',
      subject_model_resolved: 'concrete-id',
      verdict: 'pass',
    }),
  ];
  const o = outcomeCapability(events, NOW);
  near(o['concrete-id']!.bugfix!.rate, 1);
  assert.equal(o['raw-alias'], undefined);
});

test('subject_model alone is used when subject_model_resolved is absent', () => {
  const events: LedgerEvent[] = [
    outcome({
      task_id: 'a',
      subject_id: 'a',
      subject_model: 'only-raw',
      subject_model_resolved: undefined,
      verdict: 'pass',
    }),
  ];
  const o = outcomeCapability(events, NOW);
  near(o['only-raw']!.bugfix!.rate, 1);
});

test('user feedback voter correctly aggregates and adjusts the overlay', () => {
  const events: LedgerEvent[] = [
    outcome({ task_id: 'a', subject_id: 'a', voter: 'user', verdict: 'pass', subject_model: 'model-x', subject_model_resolved: 'model-x' }),
    outcome({ task_id: 'b', subject_id: 'b', voter: 'user', verdict: 'fail', subject_model: 'model-x', subject_model_resolved: 'model-x' }),
  ];
  const o = outcomeCapability(events, NOW);
  near(o['model-x']!.bugfix!.rate, 0.5);
  near(o['model-x']!.bugfix!.n, 2);
});