/**
 * F1-S3 — the observed-capability overlay wired into selection. Verifies the
 * declared/effective split Codex required:
 *  - routeDecide / reassignmentTarget / selectEscalationTarget use EFFECTIVE;
 *  - selectReviewManager and the declared-0 opt-out stay on DECLARED.
 * Relative source imports (no-build test rule).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { effectiveCapability, routeDecide } from '../src/route.ts';
import { reassignmentTarget, selectEscalationTarget } from '../src/reassign.ts';
import { selectReviewManager } from '../src/review.ts';
import type { Lane, Policy, RouteContext, Task } from '../src/types.ts';

const lane = (over: Partial<Lane> & { id: string }): Lane => ({
  kind: 'cli', model: 'm', trust_mode: 'full', costBasis: 'subscription',
  provenance: 'anthropic', jurisdiction: 'US', ...over,
});

const task: Task = { category: 'bugfix' };
const noPolicy: Policy = {};
const publicCtx = { policyContext: { repo_class: 'public', sensitivity: 'normal' } } as const;

const strong = lane({ id: 'strong', costBasis: 'subscription', capability: { bugfix: 0.85 } });
const cheap = lane({ id: 'cheap', costBasis: 'local', capability: { bugfix: 0.6 } });

test('routeDecide: a cheap lane overtakes a higher-declared lane once it earns evidence', () => {
  const base: RouteContext = { lanes: [strong, cheap], ...publicCtx };
  // No overlay ⇒ declared scores rule: strong (0.85 − 0.05) > cheap (0.60).
  assert.equal(routeDecide(task, base, noPolicy).laneId, 'strong');
  // Strong, consistent evidence lifts the cheap lane's effective capability ⇒ it wins.
  const overlay = { cheap: { bugfix: { rate: 1.0, n: 100_000 } } };
  const d = routeDecide(task, { ...base, observedCapability: overlay }, noPolicy);
  assert.equal(d.laneId, 'cheap');
});

test('routeDecide: scores carry declared + evidenceN and the reason is annotated when evidence moved it', () => {
  const overlay = { cheap: { bugfix: { rate: 1.0, n: 100_000 } } };
  const d = routeDecide(task, { lanes: [strong, cheap], ...publicCtx, observedCapability: overlay }, noPolicy);
  const cs = d.scores.find((s) => s.laneId === 'cheap')!;
  assert.equal(cs.factors.declared, 0.6);
  assert.ok(cs.factors.evidenceN > 1);
  assert.ok(cs.factors.capability > 0.95, 'effective capability lifted toward observed');
  assert.match(d.reason, /learned/);
});

test('routeDecide: the "learned" annotation is suppressed when evidence is below the threshold', () => {
  // n < 1 nudges the rounded value (0.85 → 0.86) but must NOT be announced as learned.
  const nudge = { strong: { bugfix: { rate: 1.0, n: 0.5 } } };
  const d = routeDecide(task, { lanes: [strong, cheap], ...publicCtx, observedCapability: nudge }, noPolicy);
  assert.equal(d.laneId, 'strong');
  assert.doesNotMatch(d.reason, /learned/);
});

test('declared-0 is a hard opt-out that evidence cannot resurrect', () => {
  assert.equal(effectiveCapability(0, { rate: 1.0, n: 100_000 }), 0);
  const optout = lane({ id: 'optout', costBasis: 'local', capability: { bugfix: 0 } });
  const d = routeDecide(
    task,
    { lanes: [strong, optout], ...publicCtx, observedCapability: { optout: { bugfix: { rate: 1.0, n: 100_000 } } } },
    noPolicy,
  );
  assert.equal(d.laneId, 'strong');
  assert.equal(d.scores.find((s) => s.laneId === 'optout')!.factors.capability, 0);
});

test('selectReviewManager stays on DECLARED capability (task success ≠ reviewer reliability)', () => {
  const subject = lane({ id: 'subj', provenance: 'moonshot', manager_allowed: false, capability: { bugfix: 0.6 } });
  const mgr = lane({ id: 'mgr', provenance: 'anthropic', manager_allowed: true, capability: { bugfix: 0.7 } });
  // Overwhelming evidence would lift the subject's EFFECTIVE bugfix above the
  // manager's 0.7 — if manager selection used effective, mgr would drop out.
  const ctx: RouteContext = { lanes: [subject, mgr], ...publicCtx, observedCapability: { subj: { bugfix: { rate: 1.0, n: 100_000 } } } };
  assert.equal(selectReviewManager([subject, mgr], subject, 'bugfix', ctx, noPolicy)?.id, 'mgr');
});

test('selectEscalationTarget uses EFFECTIVE: evidence can make a near-miss target eligible', () => {
  const subject = lane({ id: 'subjE', capability: { bugfix: 0.6 } });
  const cand = lane({ id: 'cand', provenance: 'openai', capability: { bugfix: 0.7 } }); // delta 0.1 < 0.15
  const ctxNo: RouteContext = { lanes: [], ...publicCtx };
  assert.equal(selectEscalationTarget(subject, [cand], task, ctxNo, noPolicy), null);
  const ctxYes: RouteContext = { ...ctxNo, observedCapability: { cand: { bugfix: { rate: 1.0, n: 100_000 } } } };
  assert.equal(selectEscalationTarget(subject, [cand], task, ctxYes, noPolicy)?.id, 'cand');
});

test('selectEscalationTarget uses EFFECTIVE: evidence can disqualify an empirically-failing target', () => {
  const subject = lane({ id: 'subjE', capability: { bugfix: 0.6 } });
  const cand = lane({ id: 'dcand', provenance: 'openai', capability: { bugfix: 0.9 } }); // delta 0.3 ≥ 0.15
  const ctxNo: RouteContext = { lanes: [], ...publicCtx };
  assert.equal(selectEscalationTarget(subject, [cand], task, ctxNo, noPolicy)?.id, 'dcand');
  const ctxBad: RouteContext = { ...ctxNo, observedCapability: { dcand: { bugfix: { rate: 0.0, n: 100_000 } } } };
  assert.equal(selectEscalationTarget(subject, [cand], task, ctxBad, noPolicy), null);
});

test('reassignmentTarget uses EFFECTIVE for the same-tier "more capable" test', () => {
  const from = lane({ id: 'x', capability: { bugfix: 0.5 } });
  const to = lane({ id: 'y', provenance: 'openai', capability: { bugfix: 0.6 } });
  const ctxNo: RouteContext = { lanes: [], ...publicCtx };
  assert.equal(reassignmentTarget(from, [to], task, ctxNo, noPolicy)?.id, 'y');
  // Evidence drags y's effective capability below x ⇒ no longer an improvement.
  const ctxBad: RouteContext = { ...ctxNo, observedCapability: { y: { bugfix: { rate: 0.0, n: 100_000 } } } };
  assert.equal(reassignmentTarget(from, [to], task, ctxBad, noPolicy), null);
});
