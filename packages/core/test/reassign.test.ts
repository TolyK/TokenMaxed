import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canReassign, reassignmentTarget, shouldReassign, TRUST_RANK } from '../src/reassign.ts';
import type { Lane, Policy, RouteContext, Task } from '../src/types.ts';

const lane = (over: Partial<Lane> & { id: string }): Lane => ({
  kind: 'cli', model: 'm', trust_mode: 'full', costBasis: 'subscription',
  provenance: 'anthropic', jurisdiction: 'US', ...over,
});

const worker = lane({ id: 'worker', kind: 'api', trust_mode: 'worker', costBasis: 'metered', provenance: 'deepseek', capability: { bugfix: 0.99 } });
const fullA = lane({ id: 'full-a', provenance: 'anthropic', capability: { bugfix: 0.9 } });
const fullB = lane({ id: 'full-b', provenance: 'openai', capability: { bugfix: 0.95 } });
const blocked = lane({ id: 'blk', trust_mode: 'blocked' });
const monitored = lane({ id: 'mon', trust_mode: 'monitored' });

const task: Task = { category: 'bugfix' };
const safeCtx: RouteContext = { lanes: [], policyContext: { repo_class: 'public', sensitivity: 'normal' } };
const noPolicy: Policy = {};

test('TRUST_RANK orders blocked < worker < monitored < full', () => {
  assert.ok(TRUST_RANK.blocked < TRUST_RANK.worker);
  assert.ok(TRUST_RANK.worker < TRUST_RANK.monitored);
  assert.ok(TRUST_RANK.monitored < TRUST_RANK.full);
});

test('shouldReassign triggers on needs-rework/fail only', () => {
  assert.equal(shouldReassign('pass'), false);
  assert.equal(shouldReassign('needs-rework'), true);
  assert.equal(shouldReassign('fail'), true);
});

test('canReassign: up the ladder + policy-allowed only', () => {
  assert.equal(canReassign(worker, fullA, task, safeCtx, noPolicy), true); // worker → full, allowed
  assert.equal(canReassign(fullA, worker, task, safeCtx, noPolicy), false); // never move down
  assert.equal(canReassign(worker, worker, task, safeCtx, noPolicy), false); // same lane
  assert.equal(canReassign(worker, blocked, task, safeCtx, noPolicy), false); // blocked never a target
  assert.equal(canReassign(worker, monitored, task, safeCtx, noPolicy), false); // monitored deferred
});

test('canReassign refuses an administratively disabled lane', () => {
  const policy: Policy = { disabledLaneIds: ['full-a'] };
  assert.equal(canReassign(worker, fullA, task, safeCtx, policy), false);
  // And reassignmentTarget skips it, choosing the other allowed full lane.
  assert.equal(reassignmentTarget(worker, [fullA, fullB], task, safeCtx, policy)?.id, 'full-b');
});

test('same-tier reassignment is allowed (escalate to a stronger trusted model)', () => {
  // full → full is trust-safe and the primary use case; never blocked.
  assert.equal(canReassign(fullA, fullB, task, safeCtx, noPolicy), true);
  // reassignmentTarget escalates a weak full lane to a more-capable full lane.
  assert.equal(reassignmentTarget(fullA, [fullB], task, safeCtx, noPolicy)?.id, 'full-b');
  // ...but not laterally to an equal/worse lane (no improvement).
  const fullWorse = lane({ id: 'full-c', capability: { bugfix: 0.5 } });
  assert.equal(reassignmentTarget(fullB, [fullWorse], task, safeCtx, noPolicy), null);
});

test('canReassign respects the policy gate for the target', () => {
  // Block the openai full lane for bugfix; cannot reassign to it.
  const policy: Policy = { rules: [{ provenance: 'openai', category: 'bugfix', verdict: 'block' }] };
  assert.equal(canReassign(worker, fullB, task, safeCtx, policy), false);
  assert.equal(canReassign(worker, fullA, task, safeCtx, policy), true);
});

test('reassignmentTarget escalates to the strongest, most-capable allowed lane', () => {
  // From a worker, with two full lanes available, pick the higher-capability full one.
  const t = reassignmentTarget(worker, [fullA, fullB, worker], task, safeCtx, noPolicy);
  assert.equal(t?.id, 'full-b'); // both full; full-b has higher bugfix capability
});

test('reassignmentTarget returns null when no strictly-stronger lane is allowed', () => {
  // Only same-rank workers available.
  const otherWorker = lane({ id: 'w2', kind: 'api', trust_mode: 'worker', costBasis: 'metered' });
  assert.equal(reassignmentTarget(worker, [otherWorker], task, safeCtx, noPolicy), null);
  // A full lane that is policy-blocked is not a valid target.
  const policy: Policy = { rules: [{ trust_mode: 'full', verdict: 'block' }] };
  assert.equal(reassignmentTarget(worker, [fullA, fullB], task, safeCtx, policy), null);
});

test('reassignmentTarget honors the loop-guard (max reassignments)', () => {
  assert.equal(reassignmentTarget(worker, [fullA], task, safeCtx, noPolicy, { attempts: 2, maxReassignments: 2 }), null);
  assert.ok(reassignmentTarget(worker, [fullA], task, safeCtx, noPolicy, { attempts: 1, maxReassignments: 2 }));
});
