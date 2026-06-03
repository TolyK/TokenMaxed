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
  near(o['codex-cli']!.bugfix!.rate, 1);
  near(o['codex-cli']!.bugfix!.n, 1);
});

test('verdicts map onto the dogfood scale (pass=1, needs-rework=½, fail=0)', () => {
  const events: LedgerEvent[] = [
    outcome({ task_id: 'a', subject_id: 'a', verdict: 'pass' }),
    outcome({ task_id: 'b', subject_id: 'b', verdict: 'needs-rework' }),
    outcome({ task_id: 'c', subject_id: 'c', verdict: 'fail' }),
  ];
  const o = outcomeCapability(events, NOW);
  near(o['codex-cli']!.bugfix!.rate, (1 + 0.5 + 0) / 3);
  near(o['codex-cli']!.bugfix!.n, 3);
});

test('recency decay: an outcome one half-life old weighs half a fresh one', () => {
  const events: LedgerEvent[] = [
    outcome({ task_id: 'fresh', subject_id: 'fresh', ts: isoDaysAgo(0), verdict: 'pass' }),
    outcome({ task_id: 'old', subject_id: 'old', ts: isoDaysAgo(DEFAULT_HALF_LIFE_DAYS), verdict: 'fail' }),
  ];
  const o = outcomeCapability(events, NOW);
  // fresh: weight 1 value 1; old: weight 0.5 value 0 ⇒ rate = 1/1.5, n = 1.5
  near(o['codex-cli']!.bugfix!.rate, 1 / 1.5);
  near(o['codex-cli']!.bugfix!.n, 1.5);
});

test('de-dup: only the latest (max seq) outcome per (task,attempt,lane,category) counts', () => {
  const events: LedgerEvent[] = [
    outcome({ seq: 1, verdict: 'fail' }), // earlier review of the same attempt
    outcome({ seq: 5, verdict: 'pass' }), // latest review wins
  ];
  const o = outcomeCapability(events, NOW);
  near(o['codex-cli']!.bugfix!.rate, 1); // pass, not the fail
  near(o['codex-cli']!.bugfix!.n, 1); // counted once, not twice
});

test('non-reviewer / unattributed / host-turn / task events are excluded', () => {
  const taskEvent = { event_type: 'task' } as unknown as TaskEvent;
  const events: LedgerEvent[] = [
    outcome({ task_id: 'u', subject_id: 'u', voter: 'user', verdict: 'fail' }), // user vote
    outcome({ subject_id: 'h', subject_type: 'host_turn', task_id: undefined, turn_id: 'x', subject_lane_id: undefined }),
    outcome({ task_id: 'n', subject_id: 'n', subject_lane_id: undefined }), // unattributed
    outcome({ task_id: undefined, subject_id: 'z' }), // no task_id
    taskEvent,
  ];
  assert.equal(Object.keys(outcomeCapability(events, NOW)).length, 0);
});

test('future-dated outcomes are clamped to age 0 (weight ≤ 1, never amplified)', () => {
  const o = outcomeCapability([outcome({ ts: isoDaysAgo(-100), verdict: 'pass' })], NOW);
  near(o['codex-cli']!.bugfix!.n, 1); // weight 1, not >1
});

test('outcomes with an unparseable timestamp are dropped', () => {
  assert.equal(Object.keys(outcomeCapability([outcome({ ts: 'not-a-date' })], NOW)).length, 0);
});

test('invalid halfLifeDays falls back to the default', () => {
  const events: LedgerEvent[] = [outcome({ ts: isoDaysAgo(DEFAULT_HALF_LIFE_DAYS), verdict: 'pass' })];
  const expected = outcomeCapability(events, NOW); // default
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const got = outcomeCapability(events, NOW, { halfLifeDays: bad });
    near(got['codex-cli']!.bugfix!.n, expected['codex-cli']!.bugfix!.n);
  }
});

test('lanes and categories are aggregated independently', () => {
  const events: LedgerEvent[] = [
    outcome({ task_id: 'a', subject_id: 'a', subject_lane_id: 'codex-cli', category: 'bugfix', verdict: 'pass' }),
    outcome({ task_id: 'b', subject_id: 'b', subject_lane_id: 'codex-cli', category: 'docs', verdict: 'fail' }),
    outcome({ task_id: 'c', subject_id: 'c', subject_lane_id: 'kimi', category: 'bugfix', verdict: 'needs-rework' }),
  ];
  const o = outcomeCapability(events, NOW);
  near(o['codex-cli']!.bugfix!.rate, 1);
  near(o['codex-cli']!.docs!.rate, 0);
  near(o['kimi']!.bugfix!.rate, 0.5);
  assert.equal(o['kimi']!.docs, undefined);
});
