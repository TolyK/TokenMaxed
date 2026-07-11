/**
 * P6 §4 (A2) — difficulty-conditioned learning + routing: the
 * outcomeCapabilityByDifficulty aggregator, the back-off ladder
 * (difficulty cell → category cell → declared/prior) in effective capability,
 * the routeDecide behavior flip for a difficulty-tagged task, the opt-out
 * invariant, and difficulty-aware escalation-target ranking. Relative source
 * imports (no-build test rule).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { outcomeCapability, outcomeCapabilityByDifficulty } from '../src/feedback.ts';
import { SCHEMA_VERSION } from '../src/ledger.ts';
import type { OutcomeEvent } from '../src/ledger.ts';
import { DEFAULT_PRIOR_STRENGTH, effectiveOptsForTask, routeDecide } from '../src/route.ts';
import { selectEscalationTarget } from '../src/reassign.ts';
import type {
  Lane,
  ObservedCapabilityByModel,
  ObservedCapabilityByModelDifficulty,
  Policy,
  RouteContext,
  Task,
} from '../src/types.ts';

const MS_PER_DAY = 86_400_000;
const NOW = Date.parse('2026-06-02T00:00:00.000Z');
const K = DEFAULT_PRIOR_STRENGTH; // 8

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
    subject_model: 'model-a',
    subject_model_resolved: 'model-a',
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

function near(actual: number | undefined, expected: number, eps = 1e-9): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= eps, `expected ${actual} ≈ ${expected}`);
}

const lane = (over: Partial<Lane> & { id: string }): Lane => ({
  kind: 'cli', model: 'm', trust_mode: 'full', costBasis: 'subscription',
  provenance: 'anthropic', jurisdiction: 'US', ...over,
});

const noPolicy: Policy = {};

// --- aggregation ------------------------------------------------------------------

test('outcomeCapabilityByDifficulty: buckets accumulate separately per difficulty', () => {
  const overlay = outcomeCapabilityByDifficulty(
    [
      outcome({ task_id: 'a', subject_id: 'a', difficulty: 'hard', verdict: 'pass' }),
      outcome({ task_id: 'b', subject_id: 'b', difficulty: 'easy', verdict: 'fail' }),
    ],
    NOW,
  );
  near(overlay['model-a']?.bugfix?.hard?.rate, 1);
  near(overlay['model-a']?.bugfix?.hard?.n, 1);
  near(overlay['model-a']?.bugfix?.easy?.rate, 0);
  assert.equal(overlay['model-a']?.bugfix?.moderate, undefined);
});

test('outcomeCapabilityByDifficulty: unbucketed outcomes are excluded here but still count category-level', () => {
  const events = [outcome({ task_id: 'a', subject_id: 'a', difficulty: undefined, verdict: 'pass' })];
  assert.equal(Object.keys(outcomeCapabilityByDifficulty(events, NOW)).length, 0);
  near(outcomeCapability(events, NOW)['model-a']?.bugfix?.n, 1); // category view unaffected
});

test('outcomeCapabilityByDifficulty: de-dup keeps the latest outcome per attempt (its difficulty rides along)', () => {
  const overlay = outcomeCapabilityByDifficulty(
    [
      outcome({ task_id: 'a', subject_id: 'a', attempt: 0, seq: 100, difficulty: 'hard', verdict: 'fail' }),
      outcome({ task_id: 'a', subject_id: 'a', attempt: 0, seq: 101, difficulty: 'hard', verdict: 'pass' }),
    ],
    NOW,
  );
  near(overlay['model-a']?.bugfix?.hard?.rate, 1);
  near(overlay['model-a']?.bugfix?.hard?.n, 1);
});

test('outcomeCapabilityByDifficulty: recency decay matches the category-level aggregator', () => {
  const overlay = outcomeCapabilityByDifficulty(
    [outcome({ task_id: 'a', subject_id: 'a', ts: isoDaysAgo(30), difficulty: 'hard' })],
    NOW,
  );
  near(overlay['model-a']?.bugfix?.hard?.n, 0.5); // one half-life
});

// --- opts assembly ------------------------------------------------------------------

test('effectiveOptsForTask: undefined when nothing applies; difficulty fields only when BOTH present', () => {
  const diffOverlay: ObservedCapabilityByModelDifficulty = { 'model-a': { bugfix: { hard: { rate: 1, n: 5 } } } };
  assert.equal(effectiveOptsForTask({ lanes: [] }, { category: 'bugfix' }), undefined);
  assert.equal(effectiveOptsForTask({ lanes: [] }, { category: 'bugfix', difficulty: 'hard' }), undefined);
  assert.equal(
    effectiveOptsForTask({ lanes: [], observedCapabilityByModelDifficulty: diffOverlay }, { category: 'bugfix' }),
    undefined,
  );
  const opts = effectiveOptsForTask(
    { lanes: [], observedCapabilityByModelDifficulty: diffOverlay },
    { category: 'bugfix', difficulty: 'hard' },
  );
  assert.equal(opts?.difficulty, 'hard');
  assert.equal(opts?.difficultyOverlay, diffOverlay);
});

// --- routing ladder ------------------------------------------------------------------

const strongCat = lane({ id: 'strong-cat', model: 'model-a', capability: { bugfix: 0.8 } });
const hardPasser = lane({ id: 'hard-passer', model: 'model-b', capability: { bugfix: 0.6 } });
const DIFF: ObservedCapabilityByModelDifficulty = {
  'model-a': { bugfix: { hard: { rate: 0, n: 20 } } },
  'model-b': { bugfix: { hard: { rate: 1, n: 20 } } },
};

test('routeDecide: a hard-tagged task flips to the model that keeps passing hard reviews', () => {
  const ctx: RouteContext = { lanes: [strongCat, hardPasser], observedCapabilityByModelDifficulty: DIFF };
  // No difficulty ⇒ category-level declared scores (byte-identical to before).
  const plain = routeDecide({ category: 'bugfix' }, ctx, noPolicy);
  assert.equal(plain.laneId, 'strong-cat');
  near(plain.scores.find((s) => s.laneId === 'strong-cat')?.factors.capability, 0.8);
  near(plain.scores.find((s) => s.laneId === 'hard-passer')?.factors.capability, 0.6);
  // Hard-tagged ⇒ the cell blends toward the category-level value with k=8.
  const hard = routeDecide({ category: 'bugfix', difficulty: 'hard' }, ctx, noPolicy);
  assert.equal(hard.laneId, 'hard-passer');
  near(hard.scores.find((s) => s.laneId === 'strong-cat')?.factors.capability, (K * 0.8) / (K + 20));
  near(hard.scores.find((s) => s.laneId === 'hard-passer')?.factors.capability, (K * 0.6 + 20) / (K + 20));
});

test('routeDecide: back-off — no cell for the tagged difficulty ⇒ category-level scores unchanged', () => {
  const ctx: RouteContext = { lanes: [strongCat, hardPasser], observedCapabilityByModelDifficulty: DIFF };
  const moderate = routeDecide({ category: 'bugfix', difficulty: 'moderate' }, ctx, noPolicy);
  assert.equal(moderate.laneId, 'strong-cat');
  near(moderate.scores.find((s) => s.laneId === 'strong-cat')?.factors.capability, 0.8);
  near(moderate.scores.find((s) => s.laneId === 'hard-passer')?.factors.capability, 0.6);
});

test('routeDecide: a difficulty-tagged task WITHOUT the overlay is byte-identical to untagged', () => {
  const ctx: RouteContext = { lanes: [strongCat, hardPasser] };
  const tagged = routeDecide({ category: 'bugfix', difficulty: 'hard' }, ctx, noPolicy);
  const untagged = routeDecide({ category: 'bugfix' }, ctx, noPolicy);
  assert.equal(tagged.laneId, untagged.laneId);
  assert.deepEqual(tagged.scores, untagged.scores);
});

test('ladder composes: cell blends toward the category-observed blend, not raw declared', () => {
  const catOverlay: ObservedCapabilityByModel = { 'model-a': { bugfix: { rate: 1, n: 12 } } };
  const ctx: RouteContext = {
    lanes: [strongCat],
    observedCapabilityByModel: catOverlay,
    observedCapabilityByModelDifficulty: DIFF,
  };
  const d = routeDecide({ category: 'bugfix', difficulty: 'hard' }, ctx, noPolicy);
  const base = (K * 0.8 + 12 * 1) / (K + 12); // category level: 0.92
  near(d.scores.find((s) => s.laneId === 'strong-cat')?.factors.capability, (K * base) / (K + 20));
});

test('invariant: capability-0 opt-out is never resurrected by a glowing difficulty cell', () => {
  const optOut = lane({ id: 'opt-out', model: 'model-b', capability: { bugfix: 0 } });
  const ctx: RouteContext = { lanes: [strongCat, optOut], observedCapabilityByModelDifficulty: DIFF };
  const d = routeDecide({ category: 'bugfix', difficulty: 'hard' }, ctx, noPolicy);
  assert.notEqual(d.laneId, 'opt-out');
  near(d.scores.find((s) => s.laneId === 'opt-out')?.factors.capability, 0);
});

// --- escalation-target ranking ------------------------------------------------------

test('selectEscalationTarget: a hard-tagged task ranks targets by their HARD-cell record', () => {
  const subject = lane({ id: 'subject', model: 'model-s', capability: { bugfix: 0.5 } });
  const t1 = lane({ id: 't1', model: 'model-t1', capability: { bugfix: 0.9 } });
  const t2 = lane({ id: 't2', model: 'model-t2', capability: { bugfix: 0.9 } });
  const diff: ObservedCapabilityByModelDifficulty = {
    'model-t1': { bugfix: { hard: { rate: 0.2, n: 30 } } },
    'model-t2': { bugfix: { hard: { rate: 0.9, n: 30 } } },
  };
  const baseCtx: RouteContext = { lanes: [], policyContext: { repo_class: 'public', sensitivity: 'normal' } };
  // Untagged: both targets tie at 0.9 ⇒ deterministic id tie-break picks t1.
  const untaggedTask: Task = { category: 'bugfix' };
  assert.equal(
    selectEscalationTarget(subject, [t1, t2], untaggedTask, { ...baseCtx, observedCapabilityByModelDifficulty: diff }, noPolicy)?.id,
    't1',
  );
  // Hard-tagged: t1's hard record ((8·0.9+30·0.2)/38 ≈ 0.347) fails the min-delta
  // bar over the subject (0.5+0.15); t2 ((8·0.9+30·0.9)/38 = 0.9) is chosen — an
  // empirically hard-failing lane is no longer a valid escalation target.
  const hardTask: Task = { category: 'bugfix', difficulty: 'hard' };
  assert.equal(
    selectEscalationTarget(subject, [t1, t2], hardTask, { ...baseCtx, observedCapabilityByModelDifficulty: diff }, noPolicy)?.id,
    't2',
  );
});
