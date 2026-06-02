import assert from 'node:assert/strict';
import { test } from 'node:test';

import { review, ReviewError } from '../src/review.ts';
import type { ManagerReviewOutput, ReviewDeps } from '../src/review.ts';
import type { Lane } from '../src/types.ts';

const manager: Lane = {
  id: 'claude-native', kind: 'cli', model: 'claude-opus-4-7', trust_mode: 'full',
  costBasis: 'subscription', provenance: 'anthropic', jurisdiction: 'US',
  manager_allowed: true,
};
const worker: Lane = {
  id: 'deepseek-api', kind: 'api', model: 'deepseek-v3', trust_mode: 'worker',
  costBasis: 'metered', provenance: 'deepseek', jurisdiction: 'CN',
};

function deps(out: ManagerReviewOutput, mgr: Lane = manager): ReviewDeps {
  return {
    managerLane: mgr,
    runManagerReview: async () => out,
    newId: () => 'review-id',
  };
}

test('reviews a router task and builds a content-free outcome event', async () => {
  const r = await review(
    { task_id: 't-1', attempt: 0, category: 'bugfix', content: 'a diff', subjectLane: worker },
    deps({ verdict: 'needs-rework', notes: 'fix the edge case', suggested_lane_id: 'claude-native' }),
  );
  assert.equal(r.verdict, 'needs-rework');
  assert.equal(r.suggested_lane_id, 'claude-native');
  assert.equal(r.event.subject_type, 'router_task');
  assert.equal(r.event.subject_id, 't-1');
  assert.equal(r.event.task_id, 't-1');
  assert.equal(r.event.subject_lane_id, 'deepseek-api');
  assert.equal(r.event.reviewer_lane_id, 'claude-native');
  assert.equal(r.event.reviewer_model, 'claude-opus-4-7');
  assert.equal(r.event.voter, 'reviewer_model');
  assert.equal(r.event.verdict, 'needs-rework');
  // The reviewed content/notes are NOT part of the recorded event.
  assert.ok(!('content' in r.event) && !('notes' in r.event));
});

test('reviews a host turn (no subject lane) via turn_id', async () => {
  const r = await review(
    { turn_id: 'turn-9', category: 'feature', content: 'cumulative diff' },
    deps({ verdict: 'pass' }),
  );
  assert.equal(r.event.subject_type, 'host_turn');
  assert.equal(r.event.subject_id, 'turn-9');
  assert.equal(r.event.turn_id, 'turn-9');
  assert.equal(r.event.task_id, undefined);
  assert.equal(r.event.subject_lane_id, undefined);
});

test('refuses an ineligible manager', async () => {
  // A worker lane (or a full lane without manager_allowed) cannot be the manager.
  await assert.rejects(
    () => review({ task_id: 't', category: 'bugfix', content: 'x' }, deps({ verdict: 'pass' }, worker)),
    ReviewError,
  );
  const notAllowed: Lane = { ...manager, manager_allowed: false };
  await assert.rejects(
    () => review({ task_id: 't', category: 'bugfix', content: 'x' }, deps({ verdict: 'pass' }, notAllowed)),
    ReviewError,
  );
});

test('rejects an ambiguous subject (both or neither id)', async () => {
  await assert.rejects(
    () => review({ task_id: 't', turn_id: 'turn', category: 'bugfix', content: 'x' }, deps({ verdict: 'pass' })),
    ReviewError,
  );
  await assert.rejects(
    () => review({ category: 'bugfix', content: 'x' }, deps({ verdict: 'pass' })),
    ReviewError,
  );
  // Empty/whitespace ids are rejected BEFORE invoking the manager.
  let called = false;
  const spyDeps = { ...deps({ verdict: 'pass' }), runManagerReview: async () => { called = true; return { verdict: 'pass' as const }; } };
  await assert.rejects(() => review({ task_id: '   ', category: 'bugfix', content: 'x' }, spyDeps), ReviewError);
  assert.equal(called, false);
});

test('a BYOK manager needs explicit attestation to be eligible', async () => {
  const byok: Lane = {
    id: 'byok', kind: 'api', model: 'm', trust_mode: 'full', costBasis: 'metered',
    provenance: 'acme', jurisdiction: 'US', manager_allowed: true,
  };
  await assert.rejects(
    () => review({ task_id: 't', category: 'bugfix', content: 'x' }, deps({ verdict: 'pass' }, byok)),
    ReviewError,
  );
  const attested = await review(
    { task_id: 't', category: 'bugfix', content: 'x' },
    deps({ verdict: 'pass' }, { ...byok, attestation: true }),
  );
  assert.equal(attested.verdict, 'pass');
});
