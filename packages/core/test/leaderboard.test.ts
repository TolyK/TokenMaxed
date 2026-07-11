/**
 * P6 Phase 2a — pure local leaderboard aggregator tests.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildLeaderboard, sortLeaderboard } from '../src/leaderboard.ts';
import { SCHEMA_VERSION } from '../src/ledger.ts';
import type { LedgerEvent, OutcomeEvent, TaskEvent } from '../src/ledger.ts';

const MODEL_A = 'gpt-5-codex';
const MODEL_B = 'claude-opus-4-8';

let seq = 0;

function task(overrides: Partial<TaskEvent> = {}): TaskEvent {
  const n = seq++;
  return {
    event_type: 'task',
    schema_version: SCHEMA_VERSION,
    id: `t-${n}`,
    seq: n,
    ts: '2026-06-01T00:00:00.000Z',
    task_id: 'task-0',
    attempt: 0,
    category: 'bugfix',
    laneId: 'codex-cli',
    model: MODEL_A,
    trust_mode: 'worker',
    provenance: 'openai',
    status: 'ok',
    tokens_in: 100,
    tokens_out: 50,
    tokens_estimated: false,
    actual_cost: 0.01,
    frontier_cost: 0.05,
    metered_spent: 0.01,
    frontier_avoided: 0.04,
    metered_avoided: 0.04,
    policy_verdict: 'allow',
    ...overrides,
  };
}

function outcome(overrides: Partial<OutcomeEvent> = {}): OutcomeEvent {
  const n = seq++;
  return {
    event_type: 'outcome',
    schema_version: SCHEMA_VERSION,
    id: `o-${n}`,
    seq: n,
    ts: '2026-06-01T00:00:00.000Z',
    subject_id: 'task-0',
    subject_type: 'router_task',
    task_id: 'task-0',
    review_id: 'r-0',
    attempt: 0,
    category: 'bugfix',
    subject_lane_id: 'codex-cli',
    subject_provenance: 'openai',
    subject_model: MODEL_A,
    subject_model_resolved: MODEL_A,
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

function rowKey(r: { model: string; category: string; difficulty: string }): string {
  return `${r.model}|${r.category}|${r.difficulty}`;
}

test('no events yields an empty leaderboard', () => {
  assert.deepEqual(buildLeaderboard([]), []);
});

test('aggregates pass/needs_rework/fail counts and dogfood passRate', () => {
  const events: LedgerEvent[] = [
    outcome({ task_id: 'a', subject_id: 'a', verdict: 'pass' }),
    outcome({ task_id: 'b', subject_id: 'b', verdict: 'needs-rework' }),
    outcome({ task_id: 'c', subject_id: 'c', verdict: 'fail' }),
  ];
  const rows = buildLeaderboard(events);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.pass, 1);
  assert.equal(r.needs_rework, 1);
  assert.equal(r.fail, 1);
  assert.equal(r.total, 3);
  near(r.passRate, (1 + 0.5 + 0) / 3);
  assert.equal(r.users, 1);
});

test('joins tokens from task events by (task_id, attempt)', () => {
  const events: LedgerEvent[] = [
    task({ task_id: 'a', attempt: 0, tokens_in: 200, tokens_out: 80 }),
    task({ task_id: 'b', attempt: 1, tokens_in: 50, tokens_out: 20 }),
    outcome({ task_id: 'a', subject_id: 'a', attempt: 0, verdict: 'pass' }),
    outcome({ task_id: 'b', subject_id: 'b', attempt: 1, verdict: 'pass' }),
  ];
  const r = buildLeaderboard(events)[0]!;
  assert.equal(r.tokens_in, 250);
  assert.equal(r.tokens_out, 100);
});

test('missing task event contributes 0 tokens but keeps the verdict', () => {
  const events: LedgerEvent[] = [outcome({ task_id: 'ghost', subject_id: 'ghost', verdict: 'pass' })];
  const r = buildLeaderboard(events)[0]!;
  assert.equal(r.pass, 1);
  assert.equal(r.tokens_in, 0);
  assert.equal(r.tokens_out, 0);
});

test('groups by (model, category, difficulty)', () => {
  const events: LedgerEvent[] = [
    task({ task_id: 'a', attempt: 0, category: 'bugfix', tokens_in: 10, tokens_out: 5 }),
    task({ task_id: 'b', attempt: 0, category: 'feature', tokens_in: 20, tokens_out: 10 }),
    task({ task_id: 'c', attempt: 0, category: 'bugfix', tokens_in: 30, tokens_out: 15 }),
    outcome({ task_id: 'a', subject_id: 'a', category: 'bugfix', difficulty: 'easy', verdict: 'pass' }),
    outcome({
      task_id: 'b',
      subject_id: 'b',
      category: 'feature',
      difficulty: 'moderate',
      subject_model: MODEL_B,
      subject_model_resolved: MODEL_B,
      verdict: 'fail',
    }),
    outcome({ task_id: 'c', subject_id: 'c', category: 'bugfix', difficulty: 'hard', verdict: 'needs-rework' }),
  ];
  const byKey = Object.fromEntries(buildLeaderboard(events).map((r) => [rowKey(r), r]));
  assert.equal(byKey[`${MODEL_A}|bugfix|easy`]!.pass, 1);
  assert.equal(byKey[`${MODEL_B}|feature|moderate`]!.fail, 1);
  assert.equal(byKey[`${MODEL_A}|bugfix|hard`]!.needs_rework, 1);
  assert.equal(byKey[`${MODEL_A}|bugfix|easy`]!.tokens_in, 10);
  assert.equal(byKey[`${MODEL_B}|feature|moderate`]!.tokens_in, 20);
});

test('prefers subject_model_resolved over subject_model for grouping', () => {
  const events: LedgerEvent[] = [
    outcome({
      task_id: 'a',
      subject_id: 'a',
      subject_model: 'alias-model',
      subject_model_resolved: MODEL_A,
      verdict: 'pass',
    }),
    outcome({
      task_id: 'b',
      subject_id: 'b',
      subject_model: 'alias-model',
      subject_model_resolved: MODEL_A,
      verdict: 'fail',
    }),
  ];
  const rows = buildLeaderboard(events);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.model, MODEL_A);
  assert.equal(rows[0]!.total, 2);
});

test('excludes legacy/host-turn outcomes without a model key', () => {
  const events: LedgerEvent[] = [
    outcome({ subject_type: 'host_turn', task_id: undefined, turn_id: 'x', subject_lane_id: undefined, subject_model: undefined }),
    outcome({ task_id: 'legacy', subject_id: 'legacy', subject_model: undefined, subject_model_resolved: undefined }),
    outcome({ task_id: 'ok', subject_id: 'ok', verdict: 'pass' }),
    outcome({ task_id: 'user', subject_id: 'user', voter: 'user', verdict: 'fail' }),
  ];
  const rows = buildLeaderboard(events);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.pass, 1);
});

test('buckets missing difficulty as unknown', () => {
  const events: LedgerEvent[] = [outcome({ task_id: 'a', subject_id: 'a', difficulty: undefined, verdict: 'pass' })];
  assert.equal(buildLeaderboard(events)[0]!.difficulty, 'unknown');
});

test('sortLeaderboard by performance: passRate desc, tiebreak total desc', () => {
  const rows = buildLeaderboard([
    outcome({ task_id: 'a', subject_id: 'a', category: 'bugfix', difficulty: 'easy', verdict: 'pass' }),
    outcome({
      task_id: 'c',
      subject_id: 'c',
      category: 'feature',
      difficulty: 'easy',
      subject_model: MODEL_B,
      subject_model_resolved: MODEL_B,
      verdict: 'pass',
    }),
    outcome({
      task_id: 'd',
      subject_id: 'd',
      category: 'feature',
      difficulty: 'easy',
      subject_model: MODEL_B,
      subject_model_resolved: MODEL_B,
      verdict: 'pass',
    }),
    outcome({
      task_id: 'e',
      subject_id: 'e',
      category: 'docs',
      difficulty: 'easy',
      subject_model: MODEL_B,
      subject_model_resolved: MODEL_B,
      verdict: 'needs-rework',
    }),
  ]);
  const input = [...rows];
  const sorted = sortLeaderboard(rows, 'performance');
  assert.notEqual(sorted, rows);
  assert.deepEqual(rows, input);
  // MODEL_B feature: passRate 1, total 2 — ties MODEL_A bugfix on rate but wins on total
  assert.equal(sorted[0]!.model, MODEL_B);
  assert.equal(sorted[0]!.category, 'feature');
  near(sorted[0]!.passRate, 1);
  assert.equal(sorted[0]!.total, 2);
  assert.equal(sorted[1]!.model, MODEL_A);
  near(sorted[1]!.passRate, 1);
  assert.equal(sorted[1]!.total, 1);
});

test('sortLeaderboard by tokens: (tokens_in + tokens_out) asc, tiebreak passRate desc', () => {
  const events: LedgerEvent[] = [
    task({ task_id: 'a', attempt: 0, tokens_in: 10, tokens_out: 5 }),
    task({ task_id: 'b', attempt: 0, tokens_in: 100, tokens_out: 50 }),
    task({ task_id: 'c', attempt: 0, tokens_in: 8, tokens_out: 7 }),
    task({ task_id: 'd', attempt: 0, tokens_in: 8, tokens_out: 7 }),
    outcome({ task_id: 'a', subject_id: 'a', difficulty: 'easy', verdict: 'pass' }),
    outcome({
      task_id: 'b',
      subject_id: 'b',
      difficulty: 'moderate',
      subject_model: MODEL_B,
      subject_model_resolved: MODEL_B,
      verdict: 'pass',
    }),
    outcome({
      task_id: 'c',
      subject_id: 'c',
      difficulty: 'easy',
      category: 'feature',
      subject_model: MODEL_B,
      subject_model_resolved: MODEL_B,
      verdict: 'pass',
    }),
    outcome({
      task_id: 'd',
      subject_id: 'd',
      difficulty: 'easy',
      category: 'docs',
      subject_model: MODEL_B,
      subject_model_resolved: MODEL_B,
      verdict: 'needs-rework',
    }),
  ];
  const rows = buildLeaderboard(events);
  const sorted = sortLeaderboard(rows, 'tokens');
  // Ascending total tokens: three rows at 15, then one at 150
  assert.equal(sorted[0]!.tokens_in + sorted[0]!.tokens_out, 15);
  assert.equal(sorted[1]!.tokens_in + sorted[1]!.tokens_out, 15);
  assert.equal(sorted[2]!.tokens_in + sorted[2]!.tokens_out, 15);
  assert.equal(sorted[3]!.tokens_in + sorted[3]!.tokens_out, 150);
  // Tiebreak passRate desc among equal token totals (1, 1, 0.5)
  near(sorted[0]!.passRate, 1);
  near(sorted[1]!.passRate, 1);
  near(sorted[2]!.passRate, 0.5);
  assert.equal(sorted[2]!.category, 'docs');
  assert.equal(sorted[3]!.model, MODEL_B);
  assert.equal(sorted[3]!.difficulty, 'moderate');
  const cheap = sorted.slice(0, 3);
  assert.ok(cheap.some((r) => r.model === MODEL_A && r.category === 'bugfix'));
  assert.ok(cheap.some((r) => r.model === MODEL_B && r.category === 'feature'));
});

test('sortLeaderboard by difficulty: easy < moderate < hard < unknown, then performance', () => {
  const events: LedgerEvent[] = [
    outcome({ task_id: 'u', subject_id: 'u', difficulty: undefined, verdict: 'pass' }),
    outcome({ task_id: 'h', subject_id: 'h', difficulty: 'hard', verdict: 'pass' }),
    outcome({ task_id: 'e', subject_id: 'e', difficulty: 'easy', verdict: 'pass' }),
    outcome({ task_id: 'm', subject_id: 'm', difficulty: 'moderate', verdict: 'pass' }),
  ];
  const sorted = sortLeaderboard(buildLeaderboard(events), 'difficulty');
  assert.deepEqual(
    sorted.map((r) => r.difficulty),
    ['easy', 'moderate', 'hard', 'unknown'],
  );
});