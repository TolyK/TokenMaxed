import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runTask } from '../src/run.ts';
import type { RunDeps } from '../src/run.ts';
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
