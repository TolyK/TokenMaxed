import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runTask, runWithFallback } from '../src/run.ts';
import type { RunDeps } from '../src/run.ts';
import { LaneFailure } from '../src/failure.ts';
import type { PriceTable } from '../src/price.ts';
import type { SecretScanner } from '../src/minimize.ts';
import type { Lane, Policy, RouteContext } from '../src/types.ts';

const TABLE: PriceTable = {
  schema_version: 1,
  frontier_model: 'claude-opus-4-7',
  models: {
    'claude-opus-4-7': { inputPer1M: 15, outputPer1M: 75 },
    'gpt-5.5': { inputPer1M: 10, outputPer1M: 30 },
    'deepseek-v3': { inputPer1M: 1, outputPer1M: 2 },
  },
};

const claude: Lane = {
  id: 'claude-native', kind: 'cli', model: 'claude-opus-4-7', trust_mode: 'full',
  costBasis: 'subscription', provenance: 'anthropic', jurisdiction: 'US', capability: { feature: 0.95, bugfix: 0.9 },
};
const worker: Lane = {
  id: 'deepseek-api', kind: 'api', model: 'deepseek-v3', trust_mode: 'worker',
  costBasis: 'metered', provenance: 'deepseek', jurisdiction: 'CN', capability: { bugfix: 0.99 },
};

const cleanScan: SecretScanner = async () => ({ available: true, hasSecret: false });
const unavailableScan: SecretScanner = async () => ({ available: false, hasSecret: false });

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    executeTrusted: async () => ({ resultText: 'done' }),
    executeUntrusted: async () => ({ ok: true, resultText: 'worker done', reported: { tokens_in: 100, tokens_out: 50 } }),
    untrustedLaneDTO: (lane) => ({ id: lane.id, model: lane.model, endpoint: 'https://fake', authHandle: 'h' }),
    scanSecrets: cleanScan,
    priceTable: TABLE,
    newId: () => 'generated-id',
    ...over,
  };
}

const trustedCtx: RouteContext = { lanes: [claude] };
const workerCtx: RouteContext = {
  lanes: [worker], // worker is the only candidate (degrade-to-native is synthetic, not a lane)
  gateReady: true,
  policyContext: { repo_class: 'public', sensitivity: 'normal' },
};
const noPolicy: Policy = {};

test('full lane: executes, records one ok event with cost primitives', async () => {
  const r = await runTask({ category: 'feature', instruction: 'do it' }, trustedCtx, noPolicy, deps());
  assert.equal(r.laneId, 'claude-native');
  assert.equal(r.status, 'ok');
  assert.equal(r.resultText, 'done');
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]?.status, 'ok');
  assert.equal(r.events[0]?.trust_mode, 'full');
  assert.ok((r.events[0]?.frontier_cost ?? 0) >= 0);
});

test('native lane: records nothing (host does it; unobservable)', async () => {
  const d = deps({ executeTrusted: async () => ({ resultText: 'host did it', native: true }) });
  const r = await runTask({ category: 'feature', instruction: 'do it' }, trustedCtx, noPolicy, d);
  assert.equal(r.native, true);
  assert.equal(r.events.length, 0);
});

test('full lane failure: degrades to native and records a failed attempt', async () => {
  const d = deps({
    executeTrusted: async () => {
      throw new Error('lane crashed');
    },
  });
  const r = await runTask({ category: 'feature', instruction: 'do it' }, trustedCtx, noPolicy, d);
  assert.equal(r.status, 'failed');
  assert.equal(r.native, true);
  assert.equal(r.events[0]?.status, 'failed');
});

test('worker lane: minimizes, executes untrusted, records ok with reported usage', async () => {
  const r = await runTask({ category: 'bugfix', instruction: 'reverse a string' }, workerCtx, noPolicy, deps());
  assert.equal(r.laneId, 'deepseek-api');
  assert.equal(r.status, 'ok');
  assert.equal(r.events[0]?.tokens_in, 100);
  assert.equal(r.events[0]?.tokens_out, 50);
  assert.equal(r.events[0]?.tokens_estimated, false); // reported by the lane
  assert.equal(r.events[0]?.trust_mode, 'worker');
});

test('worker lane: a blocked minimize degrades to native and records blocked', async () => {
  // Scanner unavailable ⇒ minimize blocks ⇒ degrade.
  const r = await runTask(
    { category: 'bugfix', instruction: 'reverse a string' },
    workerCtx,
    noPolicy,
    deps({ scanSecrets: unavailableScan }),
  );
  assert.equal(r.status, 'blocked');
  assert.equal(r.native, true);
  assert.equal(r.events[0]?.status, 'blocked');
  assert.equal(r.events[0]?.laneId, 'deepseek-api');
});

test('worker lane: an untrusted execution failure degrades to native and records failed', async () => {
  const r = await runTask(
    { category: 'bugfix', instruction: 'reverse a string' },
    workerCtx,
    noPolicy,
    deps({ executeUntrusted: async () => ({ ok: false, error: 'upstream 500' }) }),
  );
  assert.equal(r.status, 'failed');
  assert.equal(r.native, true);
  assert.equal(r.events[0]?.status, 'failed');
});

test('worker minimize is gated by context: unsafe context never reaches the worker (it would not be selected)', async () => {
  // Without gateReady/public-normal, routeDecide will not pick the worker at all.
  const r = await runTask({ category: 'bugfix', instruction: 'x' }, { lanes: [worker, claude] }, noPolicy, deps());
  assert.equal(r.laneId, 'claude-native');
});

test('no selectable lane degrades to native instead of throwing', async () => {
  // Only a worker, gate not ready ⇒ routeDecide would throw; runTask degrades.
  const r = await runTask({ category: 'bugfix', instruction: 'x' }, { lanes: [worker] }, noPolicy, deps());
  assert.equal(r.native, true);
  assert.equal(r.laneId, 'native');
  assert.equal(r.events.length, 0);
  assert.equal(r.decision, undefined);
});

test('a failed worker attempt preserves reported spend (does not under-report)', async () => {
  const r = await runTask(
    { category: 'bugfix', instruction: 'reverse a string' },
    workerCtx,
    noPolicy,
    // Only prompt tokens reported (no tokens_out) — must still be recorded, not estimated.
    deps({ executeUntrusted: async () => ({ ok: false, error: 'timeout', reported: { tokens_in: 80 } }) }),
  );
  assert.equal(r.status, 'failed');
  assert.equal(r.events[0]?.status, 'failed');
  assert.equal(r.events[0]?.tokens_in, 80); // partial spend before failure is recorded
  assert.equal(r.events[0]?.tokens_estimated, false); // taken from the report, not estimated
});

test('usage estimation includes attachment content when usage is unreported', async () => {
  // Trusted lane returns no reported usage ⇒ tokens estimated from instruction + attachments.
  const withAttach = await runTask(
    { category: 'feature', instruction: 'hi', attachments: [{ content: 'x'.repeat(400), provenance: 'host-authored', repo_derived: false }] },
    trustedCtx,
    noPolicy,
    deps({ executeTrusted: async () => ({ resultText: '' }) }),
  );
  const noAttach = await runTask(
    { category: 'feature', instruction: 'hi' },
    trustedCtx,
    noPolicy,
    deps({ executeTrusted: async () => ({ resultText: '' }) }),
  );
  assert.ok((withAttach.events[0]?.tokens_in ?? 0) > (noAttach.events[0]?.tokens_in ?? 0));
});

// ---- C-12: trust-preserving fallback ------------------------------------

const fullA: Lane = {
  id: 'full-a', kind: 'cli', model: 'gpt-5.5', trust_mode: 'full',
  costBasis: 'subscription', provenance: 'openai', jurisdiction: 'US', command: 'a', capability: { bugfix: 0.9 },
};
const fullB: Lane = {
  id: 'full-b', kind: 'cli', model: 'claude-opus-4-7', trust_mode: 'full',
  costBasis: 'subscription', provenance: 'anthropic', jurisdiction: 'US', command: 'b', capability: { bugfix: 0.85 },
};

test('fallback: a transient failure on one lane retries on another (trusted) lane', async () => {
  // full-a (higher capability) is chosen first, fails transiently; falls back to full-b.
  const d = deps({
    executeTrusted: async (lane) => {
      if (lane.id === 'full-a') throw new Error('boom'); // provider_error (transient)
      return { resultText: 'b did it' };
    },
  });
  const r = await runWithFallback({ category: 'bugfix', instruction: 'x' }, { lanes: [fullA, fullB] }, noPolicy, d);
  assert.equal(r.status, 'ok');
  assert.equal(r.laneId, 'full-b');
  assert.equal(r.attempts, 2);
  // Both the failed attempt and the successful one are recorded.
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0]?.status, 'failed');
  assert.equal(r.events[1]?.status, 'ok');
  // Both events correlate: one task_id, incrementing attempt index.
  assert.equal(r.events[0]?.task_id, r.events[1]?.task_id);
  assert.equal(r.events[0]?.attempt, 0);
  assert.equal(r.events[1]?.attempt, 1);
});

test('fallback is trust-preserving: a failed full lane never falls to a worker', async () => {
  // full-a fails transiently; a capable worker exists, but fallback must NOT drop to it.
  const workerLane: Lane = { ...worker, id: 'cheap-worker', capability: { bugfix: 1 } };
  const d = deps({
    executeTrusted: async () => {
      throw new Error('boom'); // full lane fails
    },
    executeUntrusted: async () => ({ ok: true, resultText: 'worker' }),
  });
  const ctx: RouteContext = {
    lanes: [fullA, workerLane],
    gateReady: true,
    policyContext: { repo_class: 'public', sensitivity: 'normal' },
  };
  const r = await runWithFallback({ category: 'bugfix', instruction: 'x' }, ctx, noPolicy, d);
  // No other full lane ⇒ degrade to native; never the worker.
  assert.notEqual(r.laneId, 'cheap-worker');
  assert.equal(r.native, true);
});

test('a permanent failure does not trigger fallback', async () => {
  // Worker minimize blocks (policy_blocked = permanent) ⇒ no retry on other lanes.
  const d = deps({ scanSecrets: unavailableScan });
  const ctx: RouteContext = { lanes: [worker], gateReady: true, policyContext: { repo_class: 'public', sensitivity: 'normal' } };
  const r = await runWithFallback({ category: 'bugfix', instruction: 'x' }, ctx, noPolicy, d);
  assert.equal(r.attempts, 1); // no fallback attempt
  assert.equal(r.native, true);
});

test('a trusted lane throwing a typed LaneFailure preserves its kind (e.g. quota ⇒ cooldown)', async () => {
  // A full API lane out of credits: executor throws LaneFailure('quota_exhausted').
  const d = deps({
    executeTrusted: async () => {
      throw new LaneFailure('quota_exhausted', 'out of credits');
    },
  });
  const r = await runWithFallback({ category: 'bugfix', instruction: 'x' }, { lanes: [fullA] }, noPolicy, d);
  assert.equal(r.failureKind, 'quota_exhausted'); // not flattened to provider_error
  assert.ok(r.cooldownAdds.includes('full-a')); // quota ⇒ cooled down
});

test('a trusted lane throwing an auth LaneFailure is permanent (no fallback)', async () => {
  const d = deps({
    executeTrusted: async () => {
      throw new LaneFailure('auth_failed', 'bad key');
    },
  });
  const r = await runWithFallback({ category: 'bugfix', instruction: 'x' }, { lanes: [fullA, fullB] }, noPolicy, d);
  assert.equal(r.attempts, 1); // auth is permanent ⇒ no fallback to full-b
  assert.equal(r.native, true);
});

test('fallback preserves the real failure when remaining lanes are not routable', async () => {
  // Worker hits quota; the only other lane is monitored (passes the trust floor
  // but is never selectable) ⇒ keep the worker failure, do not overwrite with native.
  const w: Lane = { ...worker, id: 'w', capability: { bugfix: 0.9 } };
  const mon: Lane = { ...worker, id: 'mon', trust_mode: 'monitored', capability: { bugfix: 1 } };
  const d = deps({ executeUntrusted: async () => ({ ok: false, failureKind: 'quota_exhausted', error: 'out' }) });
  const ctx: RouteContext = { lanes: [w, mon], gateReady: true, policyContext: { repo_class: 'public', sensitivity: 'normal' } };
  const r = await runWithFallback({ category: 'bugfix', instruction: 'x' }, ctx, noPolicy, d);
  assert.equal(r.failureKind, 'quota_exhausted'); // real failure preserved, not native-ok
  assert.equal(r.laneId, 'w');
  assert.equal(r.attempts, 1);
  assert.ok(r.cooldownAdds.includes('w'));
});

test('fallback honors the loop-guard and reports cooldowns for quota/rate', async () => {
  // Both full lanes return quota_exhausted (transient + cooldown); guard caps attempts.
  const d = deps({
    executeTrusted: async () => ({ resultText: '' }), // unused (workers below)
    executeUntrusted: async () => ({ ok: false, failureKind: 'quota_exhausted', error: 'out of credits' }),
  });
  const w1: Lane = { ...worker, id: 'w1', capability: { bugfix: 0.9 } };
  const w2: Lane = { ...worker, id: 'w2', capability: { bugfix: 0.8 } };
  const ctx: RouteContext = { lanes: [w1, w2], gateReady: true, policyContext: { repo_class: 'public', sensitivity: 'normal' } };
  const r = await runWithFallback({ category: 'bugfix', instruction: 'x' }, ctx, noPolicy, d, { maxFallbacks: 1 });
  assert.equal(r.attempts, 2); // initial + 1 fallback (loop-guard)
  assert.ok(r.cooldownAdds.includes('w1')); // quota_exhausted ⇒ cooldown the lane
  assert.equal(r.native, true); // both exhausted ⇒ degrade to native
});

// --- C-13 E-4: runWithEscalation orchestrator ---------------------------------

import { runWithEscalation } from '../src/run.ts';
import type { EscalationDeps } from '../src/run.ts';

const elane = (over: Partial<Lane> & { id: string }): Lane => ({
  kind: 'cli', model: 'gpt-5.5', trust_mode: 'full', costBasis: 'subscription',
  provenance: 'anthropic', jurisdiction: 'US', ...over,
});
const eCheap = elane({ id: 'cheap', capability: { bugfix: 0.5 } });
const eTarget = elane({ id: 'target', model: 'deepseek-v3', capability: { bugfix: 0.8 } });
const eMgr = elane({ id: 'mgr', model: 'claude-opus-4-7', manager_allowed: true, capability: { bugfix: 0.95 } });

// Initial offload routes to `cheap` only; the escalation/manager pool is wider.
const eCtx: RouteContext = { lanes: [eCheap], policyContext: { repo_class: 'public', sensitivity: 'normal' } };
const ePool = [eCheap, eTarget, eMgr];
const eReq = { category: 'bugfix' as const, instruction: 'fix the bug', task_id: 't-esc' };

function edeps(verdicts: string[], over: Partial<EscalationDeps> = {}): EscalationDeps {
  let i = 0;
  return {
    ...deps({ executeTrusted: async (l) => ({ resultText: `out:${l.id}` }) }),
    runManager: async () => verdicts[Math.min(i++, verdicts.length - 1)] ?? 'VERDICT: pass',
    ...over,
  };
}

test('escalation: pass on the first review ⇒ accept (no escalation)', async () => {
  const r = await runWithEscalation(eReq, eCtx, noPolicy, edeps(['VERDICT: pass']), { candidates: ePool });
  assert.equal(r.final_action, 'accept');
  assert.equal(r.subjectLaneId, 'cheap');
  assert.equal(r.result.resultText, 'out:cheap');
  // 1 task (cheap) + 1 outcome (accept)
  assert.deepEqual(r.events.map((e) => e.kind), ['task', 'outcome']);
  assert.equal((r.events[1]!.event as { action_taken?: string }).action_taken, 'accept');
});

test('escalation: fail ⇒ escalate to a stronger lane, then accept_after_escalation', async () => {
  const r = await runWithEscalation(eReq, eCtx, noPolicy, edeps(['VERDICT: fail', 'VERDICT: pass']), { candidates: ePool });
  assert.equal(r.final_action, 'accept_after_escalation');
  assert.equal(r.subjectLaneId, 'target');
  assert.equal(r.result.resultText, 'out:target');
  // task(cheap), outcome(escalate→target), task(target), outcome(accept)
  assert.deepEqual(r.events.map((e) => e.kind), ['task', 'outcome', 'task', 'outcome']);
  const esc = r.events[1]!.event as { action_taken?: string; target_lane_id?: string };
  assert.equal(esc.action_taken, 'escalate');
  assert.equal(esc.target_lane_id, 'target');
});

test('escalation: the superseded (rejected) leg is marked, the delivered leg is not', async () => {
  const r = await runWithEscalation(eReq, eCtx, noPolicy, edeps(['VERDICT: fail', 'VERDICT: pass']), { candidates: ePool });
  assert.equal(r.final_action, 'accept_after_escalation');
  const taskEvents = r.events.filter((e) => e.kind === 'task').map((e) => e.event as { laneId: string; superseded?: boolean });
  assert.equal(taskEvents[0]!.superseded, true); // rejected cheap leg — not a saving
  assert.notEqual(taskEvents[1]!.superseded, true); // delivered escalated leg
});

test('escalation: give_back marks every leg superseded (nothing delivered)', async () => {
  // fail, but only cheap + manager ⇒ no escalation target ⇒ give_back.
  const r = await runWithEscalation(eReq, eCtx, noPolicy, edeps(['VERDICT: fail']), { candidates: [eCheap, eMgr] });
  assert.equal(r.final_action, 'give_back');
  const taskEvents = r.events.filter((e) => e.kind === 'task').map((e) => e.event as { superseded?: boolean });
  assert.ok(taskEvents.every((e) => e.superseded === true));
});

test('escalation: needs-rework ⇒ one same-lane rework, then accept_after_rework', async () => {
  const r = await runWithEscalation(eReq, eCtx, noPolicy, edeps(['VERDICT: needs-rework', 'VERDICT: pass']), { candidates: ePool });
  assert.equal(r.final_action, 'accept_after_rework');
  assert.equal(r.subjectLaneId, 'cheap'); // reworked on the same lane
  assert.deepEqual(r.events.map((e) => e.kind), ['task', 'outcome', 'task', 'outcome']);
  assert.equal((r.events[1]!.event as { action_taken?: string }).action_taken, 'rework');
});

test('escalation: no eligible manager ⇒ review_unavailable, original result kept', async () => {
  // Pool has no manager_allowed lane.
  const r = await runWithEscalation(eReq, eCtx, noPolicy, edeps(['VERDICT: fail']), { candidates: [eCheap, eTarget] });
  assert.equal(r.final_action, 'review_unavailable');
  assert.equal(r.result.resultText, 'out:cheap');
  // No outcome event recorded (no review ran).
  assert.deepEqual(r.events.map((e) => e.kind), ['task']);
});

test('escalation: fail but no qualifying target ⇒ give_back', async () => {
  // Only cheap + mgr; mgr is the manager (excluded as target), no other ≥capable lane.
  const r = await runWithEscalation(eReq, eCtx, noPolicy, edeps(['VERDICT: fail']), { candidates: [eCheap, eMgr] });
  assert.equal(r.final_action, 'give_back');
  assert.equal((r.events[1]!.event as { action_taken?: string }).action_taken, 'give_back');
});

test('escalation: unparseable verdict ⇒ review_unavailable (never a silent pass)', async () => {
  const r = await runWithEscalation(eReq, eCtx, noPolicy, edeps(['I cannot decide']), { candidates: ePool });
  assert.equal(r.final_action, 'review_unavailable');
  assert.deepEqual(r.events.map((e) => e.kind), ['task']);
});

test('escalation: a native/host offload is not reviewed (accept as-is)', async () => {
  const d = edeps(['VERDICT: fail'], { executeTrusted: async () => ({ resultText: '', native: true }) });
  const r = await runWithEscalation(eReq, eCtx, noPolicy, d, { candidates: ePool });
  assert.equal(r.final_action, 'accept');
  assert.equal(r.result.native, true);
  assert.deepEqual(r.events.map((e) => e.kind), []); // native records nothing
});
