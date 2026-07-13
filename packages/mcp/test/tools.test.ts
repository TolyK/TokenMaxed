/**
 * A-1/A-4/A-5 tests — the MCP tool handlers, exercised with fake injected deps
 * and the REAL core operations. Core is imported via its source path
 * (`../../core/src/index.ts`), not the package name, so `node --test` type-strips
 * it with no prior build — preserving the documented no-build workflow.
 *
 * Covers savings/tokens/preview, the toggle (status/set_enabled), delegate
 * (offload/native/disabled/failure), period + percentage handling, input
 * validation, and dispatch (async, unknown-tool, unknown-key).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TASK_CATEGORIES,
  eligibleLanes,
  evaluate,
  hostAllowsLane,
  modelMatchesPin,
  filterEventsSince,
  routeDecide,
  summarize,
  tokenStats,
  classifyTask,
  MIN_CLASSIFY_CONFIDENCE,
  CLASSIFY_FALLBACK_CATEGORY,
  SCHEMA_VERSION,
  serializeEvent,
  forecastCost,
  contributingOutcomes,
  analyzePlan,
  capabilityInterval,
  evidenceFreshnessDays,
  resolveLaneModelKey,
  declaredCapabilityFor,
  effectiveCapabilityFor,
  analyzeBacktest,
  fingerprintTask,
} from '../../core/src/index.ts';
import type { Lane, LedgerEvent, Policy, RouteDecision, OutcomeEventInput, OutcomeEvent, PriceTable } from '../../core/src/index.ts';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTools, dispatch, resolveCategory } from '../src/tools.ts';
import type { CorePort, DelegateOutcome, DelegateRequest, ReviewOutcome, SetupReport, ToolDeps } from '../src/tools.ts';
import { makeServerDeps } from '../src/server.ts';

// --- harness -------------------------------------------------------------------

const CORE: CorePort = {
  filterEventsSince,
  summarize,
  tokenStats,
  routeDecide,
  eligibleLanes,
  evaluate,
  hostAllowsLane,
  modelMatchesPin,
  taskCategories: TASK_CATEGORIES,
  classifyTask,
  MIN_CLASSIFY_CONFIDENCE,
  CLASSIFY_FALLBACK_CATEGORY,
  forecastCost,
  contributingOutcomes,
  analyzePlan,
  capabilityInterval,
  evidenceFreshnessDays,
  resolveLaneModelKey,
  declaredCapabilityFor,
  effectiveCapabilityFor,
  analyzeBacktest,
  fingerprintTask,
};
const TOOLS = createTools(CORE);

const FIXED_NOW = Date.parse('2026-06-02T12:00:00.000Z');

function taskEvent(over: Partial<LedgerEvent> & { ts: string; laneId: string; model: string }): LedgerEvent {
  return {
    event_type: 'task',
    schema_version: 1,
    id: over.id ?? `e-${over.ts}`,
    seq: over.seq ?? 0,
    task_id: over.task_id ?? 't1',
    attempt: 0,
    category: 'bugfix',
    trust_mode: 'full',
    provenance: 'anthropic',
    status: 'ok',
    tokens_in: 100,
    tokens_out: 50,
    tokens_estimated: false,
    actual_cost: 0.001,
    frontier_cost: 0.01,
    metered_spent: 0,
    frontier_avoided: 0.009,
    metered_avoided: 0,
    policy_verdict: 'allow',
    ...over,
  } as LedgerEvent;
}

function lane(over: Partial<Lane> & { id: string }): Lane {
  return {
    kind: 'cli',
    model: 'm',
    trust_mode: 'full',
    costBasis: 'subscription',
    provenance: 'anthropic',
    jurisdiction: 'US',
    ...over,
  } as Lane;
}

function deps(over: Partial<ToolDeps> = {}): ToolDeps {
  return {
    readLedger: () => [],
    candidateLanes: () => [lane({ id: 'claude-native', native: true })],
    observedCapability: () => undefined,
    readerEgress: false,
    loadPolicy: (): Policy => ({}),
    gateReady: true,
    getEnabled: () => true,
    setEnabled: () => {},
    delegate: async (): Promise<DelegateOutcome> => ({ laneId: 'native', status: 'ok', native: true }),
    summary: async () => ({
      enabled: true,
      meteredAvoidedLifetime: 0,
      meteredAvoided7d: 0,
      zeroMeteredShare: 1,
      windows: [],
      lanes: [],
      empty: true,
    }),
    review: async (): Promise<ReviewOutcome> => ({ reviewed: false, reason: 'no manager' }),
    setup: async (): Promise<SetupReport> => ({
      lanesPath: '/home/.tokenmaxed/lanes.yaml',
      policyPath: '/home/.tokenmaxed/policy.yaml',
      lanesCreated: true,
      policyCreated: true,
      laneCount: 3,
      gitleaksAvailable: false,
      gateReady: false,
      reviewOnStop: false,
      escalate: false,
      learnCapability: false,
      capabilityPrior: { state: 'off' },
      readerEgress: false,
      tiered: false,
      yolo: false,
      lanes: [],
      laneReview: 'current',
    }),
    routingPolicyExplicit: () => false,
    readerLanes: () => [],
    allLanes: () => [],
    doctor: async () => ({ findings: [] }),
    now: () => FIXED_NOW,
    ...over,
  };
}

/** Invoke a tool through dispatch (async; also exercises name resolution). */
function call(name: string, d: ToolDeps, args: Record<string, unknown> = {}) {
  return dispatch(TOOLS, d, name, args);
}

// --- registry + dispatch -------------------------------------------------------

test('builds the expected tool set with object input schemas', () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name).sort(),
    [
      'router_backtest',
      'router_config',
      'router_delegate',
      'router_doctor',
      'router_feedback',
      'router_plan',
      'router_preview',
      'router_review',
      'router_savings',
      'router_set_calibration',
      'router_set_enabled',
      'router_set_freeze',
      'router_set_full_access',
      'router_set_policy',
      'router_set_prefer',
      'router_set_reserve',
      'router_set_routed_share',
      'router_set_target',
      'router_set_yolo',
      'router_setup',
      'router_status',
      'router_summary',
      'router_tokens',
    ],
  );
  for (const t of TOOLS) {
    assert.equal((t.inputSchema as { type: string }).type, 'object');
    assert.ok(t.description.length > 0);
  }
});

test('router_delegate schema omits category from required; router_preview requires it', () => {
  const delegate = TOOLS.find((t) => t.name === 'router_delegate')!;
  const preview = TOOLS.find((t) => t.name === 'router_preview')!;
  assert.deepEqual((delegate.inputSchema as { required?: string[] }).required, ['instruction']);
  assert.deepEqual((preview.inputSchema as { required?: string[] }).required, ['category']);
  assert.equal(
    (delegate.inputSchema as { properties?: Record<string, unknown> }).properties?.category !== undefined,
    true,
    'delegate still advertises optional category',
  );
});

test('router_summary renders the injected summary data verbatim', async () => {
  const r = await call('router_summary', deps({
    summary: async () => ({
      enabled: true,
      meteredAvoidedLifetime: 4.1,
      meteredAvoided7d: 0.71,
      zeroMeteredShare: 0.8,
      windows: [
        { label: '24h', tokens: 1240000, meteredAvoided: 0.04, offloads: 3, nativeFallbacks: 0 },
        { label: '7d', tokens: 18900000, meteredAvoided: 0.71, offloads: 41, nativeFallbacks: 0 },
        { label: 'lifetime', tokens: 102400000, meteredAvoided: 4.1, offloads: 233, nativeFallbacks: 0 },
      ],
      lanes: [
        { id: 'codex-cli', kind: 'cli', model: 'm', trustMode: 'full', provenance: 'openai', tokensRouted: 0, requestsIn5h: 0, isActiveReviewer: true, available: true },
      ],
      activeReviewerId: 'codex-cli',
      empty: false,
    }),
  }));
  assert.notEqual(r.isError, true);
  assert.match(r.content[0]!.text, /Saved \$4\.10 in metered API spend/);
  assert.match(r.content[0]!.text, /Reviewer\n\s+Codex/); // grouped + vendor-named
  assert.ok((r.structuredContent!.summary as { enabled: boolean }).enabled);
});

test('dispatch returns an isError result for an unknown tool', async () => {
  const r = await dispatch(TOOLS, deps(), 'router_nope', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /Unknown tool/);
});

test('dispatch rejects unknown argument keys (additionalProperties:false)', async () => {
  const r1 = await dispatch(TOOLS, deps(), 'router_savings', { peroid: '7d' }); // typo
  assert.equal(r1.isError, true);
  assert.match(r1.content[0]!.text, /Unknown argument\(s\): peroid/);

  const r2 = await dispatch(TOOLS, deps(), 'router_preview', { category: 'bugfix', gateReady: true }); // wrong key
  assert.equal(r2.isError, true);
  assert.match(r2.content[0]!.text, /Unknown argument\(s\): gateReady/);
});

// --- router_savings ------------------------------------------------------------

test('savings on an empty ledger reports nothing recorded, not an error', async () => {
  const r = await call('router_savings', deps());
  assert.notEqual(r.isError, true);
  assert.match(r.content[0]!.text, /No tasks recorded/);
  assert.equal((r.structuredContent!.summary as { events: number }).events, 0);
});

test('savings aggregates avoided spend and tokens from the ledger', async () => {
  const events = [
    taskEvent({ ts: '2026-06-02T11:00:00.000Z', laneId: 'codex', model: 'gpt' }),
    taskEvent({ ts: '2026-06-02T11:30:00.000Z', laneId: 'codex', model: 'gpt', seq: 1 }),
  ];
  const r = await call('router_savings', deps({ readLedger: () => events }));
  assert.notEqual(r.isError, true);
  const summary = r.structuredContent!.summary as { events: number; savings: { frontier_avoided: number } };
  assert.equal(summary.events, 2);
  assert.ok(Math.abs(summary.savings.frontier_avoided - 0.018) < 1e-9);
  // Honest headline leads (actual spend + finance-grade metered avoided); the
  // all-frontier baseline is demoted to a clearly-labeled hypothetical.
  assert.match(r.content[0]!.text, /actual API spend/);
  assert.match(r.content[0]!.text, /metered spend avoided/);
  assert.match(r.content[0]!.text, /baseline context \(hypothetical/);
  assert.ok(r.content[0]!.text.indexOf('actual API spend') < r.content[0]!.text.indexOf('all-frontier baseline'));
});

test('savings renders percentages already in percent units (no 100x double-scale)', async () => {
  // frontier_avoided 0.009 / frontier_cost 0.01 ⇒ 90.0%, never 9000.0%.
  const events = [taskEvent({ ts: '2026-06-02T11:00:00.000Z', laneId: 'codex', model: 'gpt' })];
  const r = await call('router_savings', deps({ readLedger: () => events }));
  assert.match(r.content[0]!.text, /\(90\.0%\)/);
  assert.doesNotMatch(r.content[0]!.text, /9000/);
});

test('savings honours the period window', async () => {
  const events = [
    taskEvent({ ts: '2026-05-01T00:00:00.000Z', laneId: 'codex', model: 'gpt' }), // old, excluded by 7d
    taskEvent({ ts: '2026-06-02T11:00:00.000Z', laneId: 'codex', model: 'gpt', seq: 1 }),
  ];
  const r = await call('router_savings', deps({ readLedger: () => events }), { period: '7d' });
  assert.equal((r.structuredContent!.summary as { events: number }).events, 1);
});

test('savings rejects a malformed period', async () => {
  const r = await call('router_savings', deps(), { period: 'banana' });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /Invalid period/);
});

// --- router_tokens -------------------------------------------------------------

test('tokens groups by model by default and by lane on request', async () => {
  const events = [
    taskEvent({ ts: '2026-06-02T11:00:00.000Z', laneId: 'codex', model: 'gpt' }),
    taskEvent({ ts: '2026-06-02T11:30:00.000Z', laneId: 'ollama', model: 'llama', seq: 1 }),
  ];
  const byModel = await call('router_tokens', deps({ readLedger: () => events }));
  assert.equal(byModel.structuredContent!.by as string, 'model');
  assert.match(byModel.content[0]!.text, /by model:/);

  const byLane = await call('router_tokens', deps({ readLedger: () => events }), { by: 'lane' });
  assert.equal(byLane.structuredContent!.by as string, 'lane');
  assert.match(byLane.content[0]!.text, /codex:/);
});

test('tokens rejects an unknown grouping', async () => {
  const r = await call('router_tokens', deps(), { by: 'galaxy' });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /must be one of/);
});

// --- router_status / router_set_enabled (A-4 toggle) ---------------------------

test('status reports the current enabled state', async () => {
  const on = await call('router_status', deps({ getEnabled: () => true }));
  assert.equal(on.structuredContent!.enabled as boolean, true);
  assert.match(on.content[0]!.text, /ENABLED/);

  const off = await call('router_status', deps({ getEnabled: () => false }));
  assert.equal(off.structuredContent!.enabled as boolean, false);
  assert.match(off.content[0]!.text, /DISABLED/);
});

test('status surfaces stale-model warnings from the freshness check', async () => {
  const warned = await call('router_status', deps({
    getEnabled: () => true,
    freshness: async () => [{ laneId: 'minimax-api', family: 'minimax', pinned: 'minimax-m2', newest: 'minimax-m3', newestPriced: true }],
  }));
  assert.match(warned.content[0]!.text, /Stale pinned models/);
  assert.match(warned.content[0]!.text, /minimax-api: using minimax-m2; newer available: minimax-m3/);

  // No freshness dep (e.g. tests / non-networked) ⇒ just the enabled line, no error.
  const plain = await call('router_status', deps({ getEnabled: () => true }));
  assert.doesNotMatch(plain.content[0]!.text, /Stale/);
});

test('set_enabled persists the requested state', async () => {
  const calls: boolean[] = [];
  const r = await call('router_set_enabled', deps({ setEnabled: (e) => calls.push(e) }), { enabled: false });
  assert.notEqual(r.isError, true);
  assert.deepEqual(calls, [false]);
  assert.match(r.content[0]!.text, /DISABLED/);
});

test('set_enabled requires a boolean enabled and rejects other types', async () => {
  const missing = await call('router_set_enabled', deps(), {});
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /required/);

  const wrong = await call('router_set_enabled', deps(), { enabled: 'yes' });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0]!.text, /must be a boolean/);
});

// --- router_set_yolo / YOLO surfacing (--dangerously-skip-permissions analogue) ---

test('status surfaces a loud warning when YOLO is on, and nothing when off', async () => {
  const on = await call('router_status', deps({ getEnabled: () => true, getYolo: () => true }));
  assert.equal(on.structuredContent!.yolo as boolean, true);
  assert.match(on.content[0]!.text, /YOLO mode is ON/);

  const off = await call('router_status', deps({ getEnabled: () => true, getYolo: () => false }));
  assert.equal(off.structuredContent!.yolo as boolean, false);
  assert.doesNotMatch(off.content[0]!.text, /YOLO/);
});

test('set_yolo persists the requested state with a warning when enabling', async () => {
  const calls: boolean[] = [];
  const on = await call('router_set_yolo', deps({ setYolo: (v) => calls.push(v) }), { enabled: true });
  assert.notEqual(on.isError, true);
  assert.equal(on.structuredContent!.yolo as boolean, true);
  assert.match(on.content[0]!.text, /YOLO mode ENABLED/);

  const off = await call('router_set_yolo', deps({ setYolo: (v) => calls.push(v) }), { enabled: false });
  assert.equal(off.structuredContent!.yolo as boolean, false);
  assert.match(off.content[0]!.text, /YOLO mode DISABLED/);
  assert.deepEqual(calls, [true, false]);
});

test('set_yolo requires a boolean enabled and rejects other types', async () => {
  const missing = await call('router_set_yolo', deps(), {});
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /required/);

  const wrong = await call('router_set_yolo', deps(), { enabled: 'yes' });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0]!.text, /must be a boolean/);
});

// --- router_delegate (A-5) -----------------------------------------------------

test('delegate offloads and returns the lane result to use', async () => {
  const r = await call(
    'router_delegate',
    deps({ delegate: async () => ({ laneId: 'codex-cli', model: 'gpt-5.5', status: 'ok', resultText: 'done()' }) }),
    { category: 'codegen', instruction: 'write a hello function' },
  );
  assert.notEqual(r.isError, true);
  assert.equal(r.structuredContent!.native as boolean, false);
  assert.equal(r.structuredContent!.laneId as string, 'codex-cli');
  assert.match(r.content[0]!.text, /Offloaded to codex-cli \(gpt-5.5\)/);
  assert.match(r.content[0]!.text, /done\(\)/);
});

test('delegate renders the A3 receipt line + structured field when the outcome carries one', async () => {
  const receipt = { tokensIn: 12340, tokensOut: 2100, tokensEstimated: true, spentUsd: 0, meteredAvoidedUsd: 0.8412, legs: 2 };
  const r = await call(
    'router_delegate',
    deps({ delegate: async () => ({ laneId: 'codex-cli', model: 'gpt-5.5', status: 'ok', resultText: 'done()', receipt }) }),
    { category: 'codegen', instruction: 'write a hello function' },
  );
  assert.notEqual(r.isError, true);
  assert.match(
    r.content[0]!.text,
    /— receipt: 12,340 in \/ 2,100 out tok \(est\.\) · spent \$0\.0000 metered · est\. \$0\.8412 metered avoided · 2 legs/,
  );
  assert.deepEqual(r.structuredContent!.receipt, receipt);
});

test('delegate receipt also renders on a native give-back (spend never disappears)', async () => {
  const receipt = { tokensIn: 500, tokensOut: 100, tokensEstimated: false, spentUsd: 0.02, meteredAvoidedUsd: 0, legs: 1 };
  const r = await call(
    'router_delegate',
    deps({ delegate: async () => ({ laneId: 'native', status: 'ok', native: true, reason: 'gave back', receipt }) }),
    { category: 'codegen', instruction: 'x' },
  );
  assert.match(r.content[0]!.text, /Handle this task yourself \(native\)/);
  assert.match(r.content[0]!.text, /— receipt: 500 in \/ 100 out tok · spent \$0\.0200 metered/);
  assert.deepEqual(r.structuredContent!.receipt, receipt);
});

test('delegate output has NO receipt line when the outcome carries none (unchanged)', async () => {
  const r = await call(
    'router_delegate',
    deps({ delegate: async () => ({ laneId: 'codex-cli', model: 'gpt-5.5', status: 'ok', resultText: 'done()' }) }),
    { category: 'codegen', instruction: 'x' },
  );
  assert.doesNotMatch(r.content[0]!.text, /— receipt:/);
  assert.equal(r.structuredContent!.receipt, undefined);
});

test('delegate forwards repo-relative `files` to the delegate dep (verbatim repo facts)', async () => {
  let captured: DelegateRequest | undefined;
  const r = await call(
    'router_delegate',
    deps({
      delegate: async (req: DelegateRequest) => {
        captured = req;
        return { laneId: 'minimax-api', model: 'MiniMax-M3', status: 'ok', resultText: 'ok' };
      },
    }),
    { category: 'codegen', instruction: 'add a row', files: ['video_models.py', 'test_video_service.py'] },
  );
  assert.notEqual(r.isError, true);
  assert.deepEqual(captured?.files, ['video_models.py', 'test_video_service.py']);
});

test('delegate rejects a non-string-array `files` arg', async () => {
  const r = await call(
    'router_delegate',
    deps({ delegate: async () => ({ laneId: 'x', status: 'ok' as const }) }),
    { category: 'codegen', instruction: 'x', files: 'video_models.py' },
  );
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /must be an array of strings/);
});

test('delegate surfaces the reader-derived taint warning (F-2)', async () => {
  const r = await call(
    'router_delegate',
    deps({ delegate: async () => ({ laneId: 'gemini-reader', model: 'gemini-x', status: 'ok', resultText: 'analysis', readerDerived: true }) }),
    { category: 'explain', instruction: 'explain module' },
  );
  assert.equal(r.structuredContent!.readerDerived as boolean, true);
  assert.match(r.content[0]!.text, /reader-derived/);
  assert.match(r.content[0]!.text, /do not re-delegate/i);
});

test('delegate keeps the reader taint even when the result is UNREVIEWED', async () => {
  const r = await call(
    'router_delegate',
    deps({ delegate: async () => ({ laneId: 'gemini-reader', model: 'gemini-x', status: 'ok', resultText: 'analysis', readerDerived: true, reviewUnavailable: true }) }),
    { category: 'explain', instruction: 'explain module' },
  );
  assert.equal(r.structuredContent!.reviewUnavailable as boolean, true);
  assert.equal(r.structuredContent!.readerDerived as boolean, true);
  assert.match(r.content[0]!.text, /UNREVIEWED/);
  assert.match(r.content[0]!.text, /reader-derived/);
});

test('delegate keeps the reader taint on a native give-back (escalation reject)', async () => {
  const r = await call(
    'router_delegate',
    deps({ delegate: async () => ({ laneId: 'gemini-reader', status: 'ok', native: true, readerDerived: true, reason: 'manager review (fail) — notes quoting output' }) }),
    { category: 'explain', instruction: 'explain module' },
  );
  assert.equal(r.structuredContent!.native as boolean, true);
  assert.equal(r.structuredContent!.readerDerived as boolean, true);
  assert.match(r.content[0]!.text, /reader-derived/);
});

test('delegate forwards access_need to the delegate dep', async () => {
  let captured: DelegateRequest | undefined;
  const r = await call(
    'router_delegate',
    deps({
      delegate: async (req: DelegateRequest) => {
        captured = req;
        return { laneId: 'native', status: 'ok' as const, native: true };
      },
    }),
    { category: 'feature', instruction: 'wire the new endpoint', access_need: 'repo-tight' },
  );
  assert.notEqual(r.isError, true);
  assert.equal(captured?.access_need, 'repo-tight');
});

test('delegate rejects an unknown access_need value', async () => {
  const r = await call(
    'router_delegate',
    deps({ delegate: async () => ({ laneId: 'x', status: 'ok' as const }) }),
    { category: 'codegen', instruction: 'x', access_need: 'whenever' },
  );
  assert.equal(r.isError, true);
});

test('delegate renders an insufficient_context give-back as a native hand-back carrying the stated need', async () => {
  const r = await call(
    'router_delegate',
    deps({
      delegate: async () => ({
        laneId: 'minimax-api',
        model: 'MiniMax-M3',
        status: 'fallback' as const,
        native: true,
        failureKind: 'insufficient_context',
        resultText: 'the auth middleware and its tests',
        reason: 'worker handed back (insufficient context): the auth middleware and its tests — host should complete',
      }),
    }),
    { category: 'bugfix', instruction: 'fix the 401 on refresh' },
  );
  assert.equal(r.structuredContent!.native as boolean, true);
  assert.match(r.content[0]!.text, /Handle this task yourself \(native\)/);
  assert.match(r.content[0]!.text, /insufficient context.*auth middleware/i);
});

// --- router_preview: tandem access gate ----------------------------------------

test('preview repo-tight skips the worker and routes to the live (native) lane', async () => {
  // A capable worker that WOULD win on worker-ok, plus the native host lane.
  const lanes = [
    lane({ id: 'mm-worker', kind: 'api', trust_mode: 'worker', model: 'MiniMax-M3', capability: { codegen: 0.95 } }),
    lane({ id: 'host', native: true, capability: { codegen: 0.6 } }),
  ];
  const d = deps({ candidateLanes: () => lanes, gateReady: true });
  // worker-ok (default): the cheaper-yet-stronger worker is eligible and wins.
  const open = await call('router_preview', d, { category: 'codegen', repo_class: 'public', sensitivity: 'normal' });
  assert.equal((open.structuredContent!.decision as RouteDecision).laneId, 'mm-worker');
  // repo-tight: the worker is filtered out; only the native live-access lane remains.
  const tight = await call('router_preview', d, {
    category: 'codegen',
    repo_class: 'public',
    sensitivity: 'normal',
    access_need: 'repo-tight',
  });
  assert.equal((tight.structuredContent!.decision as RouteDecision).laneId, 'host');
});

test('delegate still returns the result when recording failed (no lost work)', async () => {
  const r = await call(
    'router_delegate',
    deps({ delegate: async () => ({ laneId: 'codex-cli', model: 'gpt-5.5', status: 'ok', resultText: 'out', recordingFailed: true }) }),
    { category: 'codegen', instruction: 'x' },
  );
  assert.equal(r.structuredContent!.native as boolean, false);
  assert.match(r.content[0]!.text, /out/);
  assert.match(r.content[0]!.text, /could not be recorded/);
  assert.equal(r.structuredContent!.recordingFailed as boolean, true);
});

test('delegate renders an accepted-after-escalation result with the lane + reason', async () => {
  const r = await call(
    'router_delegate',
    deps({ delegate: async () => ({ laneId: 'strong', model: 'opus', status: 'ok', resultText: 'fixed', reason: 'after escalation' }) }),
    { category: 'bugfix', instruction: 'x' },
  );
  assert.equal(r.structuredContent!.native as boolean, false);
  assert.match(r.content[0]!.text, /Offloaded to strong \(opus\) \(after escalation\)/);
  assert.match(r.content[0]!.text, /fixed/);
});

test('delegate flags a review-unavailable offload as UNREVIEWED (no "use this result")', async () => {
  const r = await call(
    'router_delegate',
    deps({ delegate: async () => ({ laneId: 'cheap', status: 'ok', resultText: 'maybe ok', reviewUnavailable: true, reason: 'no eligible manager' }) }),
    { category: 'bugfix', instruction: 'x' },
  );
  assert.equal(r.structuredContent!.reviewUnavailable as boolean, true);
  assert.equal(r.structuredContent!.reason as string, 'no eligible manager'); // reason preserved in structured output (carries skipped-file notes)
  assert.match(r.content[0]!.text, /UNREVIEWED/);
  assert.doesNotMatch(r.content[0]!.text, /Use this result/);
});

test('delegate respects the OFF toggle without calling delegate', async () => {
  let called = false;
  const r = await call(
    'router_delegate',
    deps({
      getEnabled: () => false,
      delegate: async () => {
        called = true;
        return { laneId: 'x', status: 'ok' };
      },
    }),
    { category: 'codegen', instruction: 'x' },
  );
  assert.equal(called, false, 'delegate must not run when disabled');
  assert.equal(r.structuredContent!.native as boolean, true);
  assert.match(r.content[0]!.text, /DISABLED/);
});

test('delegate that routes to native tells the host to do it', async () => {
  const r = await call(
    'router_delegate',
    deps({ delegate: async () => ({ laneId: 'native', status: 'ok', native: true, reason: 'no cheaper lane' }) }),
    { category: 'feature', instruction: 'big cross-file change' },
  );
  assert.equal(r.structuredContent!.native as boolean, true);
  assert.match(r.content[0]!.text, /yourself \(native\): no cheaper lane/);
});

test('delegate surfaces a lane failure as a native directive', async () => {
  const r = await call(
    'router_delegate',
    deps({ delegate: async () => ({ laneId: 'api', status: 'failed', native: true, failureKind: 'rate_limited' }) }),
    { category: 'bugfix', instruction: 'fix it' },
  );
  assert.equal(r.structuredContent!.native as boolean, true);
  assert.equal(r.structuredContent!.failureKind as string, 'rate_limited');
  assert.match(r.content[0]!.text, /lane failed \(rate_limited\)/);
});

test('delegate requires a non-empty instruction', async () => {
  const noInstr = await call('router_delegate', deps(), { category: 'bugfix', instruction: '   ' });
  assert.equal(noInstr.isError, true);
  assert.match(noInstr.content[0]!.text, /instruction/);
});

test('delegate with category OMITTED + clearly-bugfix instruction infers bugfix', async () => {
  let captured: DelegateRequest | undefined;
  const r = await call(
    'router_delegate',
    deps({
      delegate: async (req: DelegateRequest) => {
        captured = req;
        return { laneId: 'codex-cli', status: 'ok', resultText: 'fixed' };
      },
    }),
    { instruction: 'fix this crash and exception' },
  );
  assert.notEqual(r.isError, true);
  assert.equal(captured?.category, 'bugfix');
  assert.equal(r.structuredContent!.categoryInferred as boolean, true);
  assert.equal(r.structuredContent!.inferredConfidence as number > 0.5, true);
  assert.match(r.content[0]!.text, /category inferred as 'bugfix'/);
});

test('delegate with category omitted + ambiguous instruction infers feature', async () => {
  let captured: DelegateRequest | undefined;
  const r = await call(
    'router_delegate',
    deps({
      delegate: async (req: DelegateRequest) => {
        captured = req;
        return { laneId: 'codex-cli', status: 'ok', resultText: 'done' };
      },
    }),
    { instruction: 'xyz abc qrs' },
  );
  assert.notEqual(r.isError, true);
  assert.equal(captured?.category, 'feature');
  assert.equal(r.structuredContent!.categoryInferred as boolean, true);
  assert.equal(r.structuredContent!.inferredConfidence, 0);
  assert.match(r.content[0]!.text, /category inferred as 'feature'/);
});

test('delegate WITH explicit category routes verbatim and has no inference fields', async () => {
  let captured: DelegateRequest | undefined;
  const r = await call(
    'router_delegate',
    deps({
      delegate: async (req: DelegateRequest) => {
        captured = req;
        return { laneId: 'codex-cli', status: 'ok', resultText: 'done' };
      },
    }),
    { category: 'refactor', instruction: 'fix this crash and exception' },
  );
  assert.notEqual(r.isError, true);
  assert.equal(captured?.category, 'refactor');
  assert.equal(r.structuredContent!.categoryInferred, undefined);
  assert.equal(r.structuredContent!.inferredConfidence, undefined);
  assert.equal(r.structuredContent!.hint, undefined);
  assert.doesNotMatch(r.content[0]!.text, /category inferred/);
});

test('inferred delegate path records content-free ledger task event', () => {
  const instruction = 'fix this crash and exception';
  const resolution = resolveCategory(CORE, undefined, instruction);
  assert.equal(resolution.category, 'bugfix');
  assert.equal(resolution.categoryInferred, true);
  assert.ok((resolution.inferredConfidence ?? 0) > MIN_CLASSIFY_CONFIDENCE);

  const taskEvent = {
    event_type: 'task' as const,
    schema_version: SCHEMA_VERSION,
    id: 'ledger-id',
    seq: 0,
    ts: '2026-06-02T12:00:00.000Z',
    task_id: 'ledger-id',
    attempt: 0,
    category: resolution.category,
    laneId: 'codex-cli',
    model: 'gpt-5.5',
    trust_mode: 'full' as const,
    provenance: 'openai',
    status: 'ok' as const,
    tokens_in: 100,
    tokens_out: 50,
    tokens_estimated: false,
    actual_cost: 0.001,
    frontier_cost: 0.01,
    metered_spent: 0,
    frontier_avoided: 0.009,
    metered_avoided: 0.009,
    policy_verdict: 'allow' as const,
  };
  const serialized = serializeEvent(taskEvent);
  const parsed = JSON.parse(serialized) as Record<string, unknown>;

  assert.equal(parsed.category, 'bugfix');
  assert.equal(typeof resolution.inferredConfidence, 'number');
  assert.ok(!serialized.includes(instruction));
  for (const key of Object.keys(parsed)) {
    assert.doesNotMatch(key, /instruction|prompt|content|code|payload|snippet|text|path|repo|diff|secret/i);
  }
});

test('resolveCategory helper: explicit category is honored verbatim', () => {
  const r = resolveCategory(CORE, 'docs', 'fix this error');
  assert.equal(r.category, 'docs');
  assert.equal(r.categoryInferred, false);
  assert.equal(r.inferredConfidence, undefined);
  assert.equal(r.hint, undefined);
});

test('resolveCategory helper: clearly bugfix is inferred', () => {
  const r = resolveCategory(CORE, undefined, 'fix error crash exception');
  assert.equal(r.category, 'bugfix');
  assert.equal(r.categoryInferred, true);
  assert.ok(r.inferredConfidence! >= 0.5);
  assert.match(r.hint!, /category inferred as 'bugfix'/);
});

test('resolveCategory helper: ambiguous is fallback feature', () => {
  const r = resolveCategory(CORE, undefined, 'fix documentation');
  assert.equal(r.category, 'feature');
  assert.equal(r.categoryInferred, true);
  assert.ok(r.inferredConfidence! < 0.5);
  assert.match(r.hint!, /category inferred as 'feature'/);
});

test('delegate forwards repo_class/sensitivity as policy context', async () => {
  let seen: unknown;
  await call(
    'router_delegate',
    deps({
      delegate: async (req) => {
        seen = req.policyContext;
        return { laneId: 'native', status: 'ok', native: true };
      },
    }),
    { category: 'bugfix', instruction: 'fix', repo_class: 'private', sensitivity: 'sensitive' },
  );
  assert.deepEqual(seen, { repo_class: 'private', sensitivity: 'sensitive' });
});

// --- router_review (A-7) -------------------------------------------------------

test('review reports the manager verdict and notes', async () => {
  const r = await call(
    'router_review',
    deps({ review: async () => ({ reviewed: true, verdict: 'needs-rework', notes: 'fix the null check', managerLaneId: 'codex-cli' }) }),
  );
  assert.notEqual(r.isError, true);
  assert.equal(r.structuredContent!.reviewed as boolean, true);
  assert.equal(r.structuredContent!.verdict as string, 'needs-rework');
  assert.match(r.content[0]!.text, /codex-cli\): needs-rework/);
  assert.match(r.content[0]!.text, /fix the null check/);
});

test('review explains when nothing was reviewed', async () => {
  const r = await call('router_review', deps({ review: async () => ({ reviewed: false, reason: 'no working-tree changes to review' }) }));
  assert.notEqual(r.isError, true);
  assert.equal(r.structuredContent!.reviewed as boolean, false);
  assert.match(r.content[0]!.text, /No review run: no working-tree changes/);
});

// --- router_setup (A-8) --------------------------------------------------------

test('setup reports created config + status', async () => {
  const r = await call('router_setup', deps());
  assert.notEqual(r.isError, true);
  assert.match(r.content[0]!.text, /created from starter/);
  assert.match(r.content[0]!.text, /gitleaks\): NOT installed/);
  assert.match(r.content[0]!.text, /TOKENMAXED_KEY_/);
  assert.equal(r.structuredContent!.laneCount as number, 3);
});

test('setup reports the manager + open gate when present', async () => {
  const r = await call(
    'router_setup',
    deps({
      setup: async () => ({
        lanesPath: '/h/lanes.yaml',
        policyPath: '/h/policy.yaml',
        lanesCreated: false,
        policyCreated: false,
        laneCount: 4,
        managerLaneId: 'claude-haiku',
        gitleaksAvailable: true,
        gateReady: true,
        reviewOnStop: true,
        escalate: true,
        learnCapability: true,
        capabilityPrior: {
          state: 'on',
          stale: false,
          source: 'mercor-apex-v1',
          generated: '2026-06-20',
          categories: ['docs', 'explain'],
          unrankedCount: 3,
        },
        readerEgress: true,
        tiered: true,
        yolo: true,
        lanes: [
          { id: 'codex-cli', kind: 'cli', model: 'gpt-5.5', trustMode: 'full', costBasis: 'subscription', executionMode: 'answer-only', role: 'active-reviewer', available: true },
          { id: 'minimax-api', kind: 'api', model: 'minimax-m3', rawModel: 'minimax@latest', trustMode: 'worker', costBasis: 'subscription', executionMode: 'answer-only', role: 'none', available: false },
        ],
        laneReview: 'changed',
      }),
    }),
  );
  assert.match(r.content[0]!.text, /reader egress: on/);
  assert.match(r.content[0]!.text, /tiered routing: on/);
  assert.match(r.content[0]!.text, /lanes changed since you last reviewed them/); // SETUP-1 B reminder
  assert.match(r.content[0]!.text, /manager: claude-haiku/);
  assert.match(r.content[0]!.text, /worker gate: open/);
  // SETUP-1: the per-lane confirmation is rendered (model resolved, trust→permission, role).
  assert.match(r.content[0]!.text, /codex-cli \[cli\] gpt-5\.5 · trust=full.*role=reviewer \(active\)/);
  assert.match(r.content[0]!.text, /minimax-api \[api\] minimax@latest → minimax-m3 · trust=worker.*unavailable now/);
  assert.match(r.content[0]!.text, /quality escalation: on/);
  assert.match(r.content[0]!.text, /learned capability: on/);
  assert.match(r.content[0]!.text, /capability prior: ON — mercor-apex-v1, generated 2026-06-20, categories docs\/explain, 3 lane×category unranked/);
  assert.match(r.content[0]!.text, /already present/);
});

test('setup: capability prior OFF renders no line (default-off output byte-identical)', async () => {
  const r = await call('router_setup', deps()); // default fixture: state 'off'
  assert.doesNotMatch(r.content[0]!.text, /capability prior/i);
});

// --- router_preview ------------------------------------------------------------

test('preview routes a category to a lane without executing', async () => {
  const lanes = [lane({ id: 'claude-native', native: true })];
  const r = await call('router_preview', deps({ candidateLanes: () => lanes }), { category: 'bugfix' });
  assert.notEqual(r.isError, true);
  assert.equal(r.structuredContent!.native as boolean, false);
  assert.match(r.content[0]!.text, /category "bugfix" → lane "claude-native"/);
  assert.match(r.content[0]!.text, /policy verdict:/);
});

test('preview applies the learned overlay (F-1); flag-off is identical to declared', async () => {
  const strong = lane({ id: 'strong', costBasis: 'subscription', capability: { bugfix: 0.85 } });
  const cheap = lane({ id: 'cheap', costBasis: 'local', capability: { bugfix: 0.6 } });
  const lanes = [strong, cheap];
  // Flag off (overlay undefined) ⇒ declared scores ⇒ the stronger lane wins.
  const off = await call('router_preview', deps({ candidateLanes: () => lanes, observedCapability: () => undefined }), { category: 'bugfix' });
  assert.equal((off.structuredContent!.decision as { laneId: string }).laneId, 'strong');
  assert.doesNotMatch(off.content[0]!.text, /learned/);
  // Overlay with strong evidence lifts the cheap lane ⇒ it wins, and /why says so.
  const overlay = { cheap: { bugfix: { rate: 1.0, n: 100_000 } } };
  const on = await call('router_preview', deps({ candidateLanes: () => lanes, observedCapability: () => overlay }), { category: 'bugfix' });
  assert.equal((on.structuredContent!.decision as { laneId: string }).laneId, 'cheap');
  assert.match(on.content[0]!.text, /learned/);
});

test('preview applies the model-keyed overlay (P6 F-1); absent overlay is identical to declared', async () => {
  const strong = lane({ id: 'strong', model: 'strong-m', costBasis: 'subscription', capability: { bugfix: 0.85 } });
  const cheap = lane({ id: 'cheap', model: 'cheap-m', costBasis: 'local', capability: { bugfix: 0.6 } });
  const lanes = [strong, cheap];
  const off = await call('router_preview', deps({ candidateLanes: () => lanes }), { category: 'bugfix' });
  assert.equal((off.structuredContent!.decision as { laneId: string }).laneId, 'strong');
  assert.doesNotMatch(off.content[0]!.text, /learned/);
  const overlay = { 'cheap-m': { bugfix: { rate: 1.0, n: 100_000 } } };
  let consulted = 0;
  const on = await call(
    'router_preview',
    deps({
      candidateLanes: () => lanes,
      observedCapabilityByModel: () => {
        consulted++;
        return overlay;
      },
    }),
    { category: 'bugfix' },
  );
  assert.equal(consulted, 1);
  assert.equal((on.structuredContent!.decision as { laneId: string }).laneId, 'cheap');
  assert.match(on.content[0]!.text, /learned/);
});

test('preview/status renders calibrated evidence and thin evidence notes correctly', async () => {
  const lanes = [
    lane({ id: 'cheap', model: 'cheap-m', capability: { bugfix: 0.6 }, costBasis: 'local' }),
    lane({ id: 'strong', model: 'strong-m', capability: { bugfix: 0.85 }, costBasis: 'subscription' }),
  ];

  let seq = 0;
  const outcome = (ts: string, model: string, verdict: 'pass' | 'fail', voter: 'reviewer_model' | 'user' = 'reviewer_model', laneId = 'cheap'): LedgerEvent => ({
    event_type: 'outcome',
    schema_version: 1,
    id: `o-${seq}`,
    seq: seq++,
    ts,
    subject_id: 't-0',
    subject_type: 'router_task',
    task_id: `t-${seq}`,
    review_id: `r-${seq}`,
    attempt: 0,
    category: 'bugfix',
    subject_lane_id: laneId,
    subject_provenance: 'openai',
    subject_model: model,
    subject_model_resolved: model,
    reviewer_lane_id: 'claude-native',
    reviewer_model: 'claude-opus-4-7',
    reviewer_trust_mode: 'full',
    reviewer_provenance: 'anthropic',
    verdict,
    voter,
    policy_verdict: 'allow',
  } as any);

  const now = Date.parse('2026-06-02T12:00:00.000Z');
  const twoDaysAgo = new Date(now - 2 * 24 * 3600 * 1000).toISOString();

  const events: LedgerEvent[] = [];
  for (let i = 0; i < 50; i++) {
    events.push(outcome(twoDaysAgo, 'cheap-m', 'pass'));
  }

  const overlay = { 'cheap-m': { bugfix: { rate: 1.0, n: 50 } } };

  const dOn = deps({
    candidateLanes: () => lanes,
    allLanes: () => lanes,
    observedCapabilityByModel: () => overlay,
    readLedger: () => events,
    now: () => now,
  });

  const previewOn = await call('router_preview', dOn, { category: 'bugfix' });
  assert.notEqual(previewOn.isError, true);
  assert.match(previewOn.content[0]!.text, /learned:\s*blended\s*0\.94,\s*observed\s*1\.00\s*\[0\.9[2-3]\d*–1\.00\]\s*\(95%\s*CI\),\s*n=50,\s*freshness\s*2d/);

  const statusOn = await call('router_status', dOn);
  assert.notEqual(statusOn.isError, true);
  assert.match(statusOn.content[0]!.text, /cheap\s*\(cheap-m\)\s*bugfix:\s*capability\s*0\.94\s*\(blended;\s*observed\s*1\.00\s*\[0\.9[2-3]\d*–1\.00\],\s*n=50,\s*freshness\s*2d\)/);

  const dOnWithPin = await call('router_preview', dOn, { category: 'bugfix', model: 'cheap-m' });
  const expectedRawDecision = CORE.routeDecide(
    { category: 'bugfix', model: 'cheap-m' } as any,
    {
      lanes: lanes.filter((l) => CORE.modelMatchesPin(l.model, 'cheap-m')),
      observedCapability: undefined,
      observedCapabilityByModel: overlay,
      observedCapabilityByModelDifficulty: undefined,
      healthPenaltyMap: {},
      depletionForecastMap: {},
      quotaHeadroomMap: {},
      fullAccessLaneIds: [],
      gateReady: true,
    } as any,
    {}
  );
  assert.equal(
    JSON.stringify(dOnWithPin.structuredContent!.decision),
    JSON.stringify(expectedRawDecision)
  );

  const thinOverlay = { 'cheap-m': { bugfix: { rate: 1.0, n: 0.5 } } };
  const dThin = deps({
    candidateLanes: () => lanes,
    allLanes: () => lanes,
    observedCapabilityByModel: () => thinOverlay,
    readLedger: () => [outcome(twoDaysAgo, 'cheap-m', 'pass')],
    now: () => now,
  });

  const previewThin = await call('router_preview', dThin, { category: 'bugfix', model: 'cheap-m' });
  assert.match(previewThin.content[0]!.text, /declared\s*0\.60;\s*insufficient\s*outcome\s*evidence\s*\(n=0\.5\)/);

  const statusThin = await call('router_status', dThin);
  assert.match(statusThin.content[0]!.text, /cheap\s*\(cheap-m\)\s*bugfix:\s*capability\s*0\.60\s*\(declared;\s*insufficient\s*outcome\s*evidence\s*\(n=0\.5\)\)/);

  const dOff = deps({
    candidateLanes: () => lanes,
    allLanes: () => lanes,
    observedCapabilityByModel: () => undefined,
    readLedger: () => [],
    now: () => now,
  });

  const previewOff = await call('router_preview', dOff, { category: 'bugfix' });
  assert.doesNotMatch(previewOff.content[0]!.text, /learned/);
  assert.doesNotMatch(previewOff.content[0]!.text, /insufficient/);

  const statusOff = await call('router_status', dOff);
  assert.doesNotMatch(statusOff.content[0]!.text, /Learned Capabilities:/);

  const emptyOverlay = { 'cheap-m': { bugfix: { rate: 0.0, n: 0 } } };
  const dEmpty = deps({
    candidateLanes: () => lanes,
    allLanes: () => lanes,
    observedCapabilityByModel: () => emptyOverlay,
    readLedger: () => [],
    now: () => now,
  });

  // Fix 2: n <= 0 must show declared + insufficient-evidence
  const previewEmpty = await call('router_preview', dEmpty, { category: 'bugfix', model: 'cheap-m' });
  assert.match(previewEmpty.content[0]!.text, /declared\s*0\.60;\s*insufficient\s*outcome\s*evidence\s*\(n=0\)/);

  const statusEmpty = await call('router_status', dEmpty);
  assert.match(statusEmpty.content[0]!.text, /cheap\s*\(cheap-m\)\s*bugfix:\s*capability\s*0\.60\s*\(declared;\s*insufficient\s*outcome\s*evidence\s*\(n=0\)\)/);
});

test('preview applies the availability filter (skips a lane that cannot run)', async () => {
  // A free local lane ties on capability and would win on cost — but it's not
  // available, so preview must pick the available subscription lane instead.
  const localCheap = lane({ id: 'ollama', kind: 'local', costBasis: 'local', capability: { docs: 0.8 } });
  const sub = lane({ id: 'sub', costBasis: 'subscription', capability: { docs: 0.8 } });
  const lanes = [sub, localCheap];

  // No availability dep ⇒ unchecked ⇒ the local lane wins on cost (back-compat).
  const noProbe = await call('router_preview', deps({ candidateLanes: () => lanes }), { category: 'docs' });
  assert.equal((noProbe.structuredContent!.decision as { laneId: string }).laneId, 'ollama');

  // With availability listing only the subscription lane, it wins — and the probe
  // is handed exactly the gate+policy-eligible lanes (never a blocked/gated lane).
  let probed: readonly Lane[] | undefined;
  const withProbe = await call(
    'router_preview',
    deps({
      candidateLanes: () => lanes,
      availableLaneIds: async (ls) => {
        probed = ls;
        return ['sub'];
      },
    }),
    { category: 'docs' },
  );
  assert.equal((withProbe.structuredContent!.decision as { laneId: string }).laneId, 'sub');
  assert.deepEqual([...(probed ?? [])].map((l) => l.id).sort(), ['ollama', 'sub']);
});

test('preview reflects tiered routing (cheapest floor-clearer) when the server is tiered', async () => {
  const cheap = lane({ id: 'cheap', costBasis: 'subscription', capability: { docs: 0.7 } });
  const exp = lane({ id: 'exp', costBasis: 'subscription', capability: { docs: 0.95 } });
  const lanes = [cheap, exp];
  // Default (maximize): most capable wins.
  const max = await call('router_preview', deps({ candidateLanes: () => lanes }), { category: 'docs' });
  assert.equal((max.structuredContent!.decision as { laneId: string }).laneId, 'exp');
  // Tiered: cheapest lane clearing the floor wins, and /why says tiered.
  const tier = await call('router_preview', deps({ candidateLanes: () => lanes, tieredStrategy: 'tiered', tierFloor: 0.6 }), { category: 'docs' });
  assert.equal((tier.structuredContent!.decision as { laneId: string }).laneId, 'cheap');
  assert.match(tier.content[0]!.text, /tiered/);
});

test('preview defaults gate_ready to the server posture (matches what delegate would do)', async () => {
  // A worker-only candidate set, allowed by policy (public+normal). With the
  // server gate OFF, the worker is excluded pre-gate ⇒ native; with it ON, the
  // preview selects the worker — mirroring router_delegate's routing exactly.
  const lanes = [lane({ id: 'worker', kind: 'api', trust_mode: 'worker', provenance: 'deepseek', jurisdiction: 'CN' })];
  const ctx = { category: 'bugfix', repo_class: 'public', sensitivity: 'normal' };

  const gateOff = await call('router_preview', deps({ candidateLanes: () => lanes, gateReady: false }), ctx);
  assert.equal(gateOff.structuredContent!.native as boolean, true);

  const gateOn = await call('router_preview', deps({ candidateLanes: () => lanes, gateReady: true }), ctx);
  assert.equal(gateOn.structuredContent!.native as boolean, false);
  assert.match(gateOn.content[0]!.text, /lane "worker"/);
});

test('preview honors an explicit gate_ready override of the server posture', async () => {
  const lanes = [lane({ id: 'worker', kind: 'api', trust_mode: 'worker', provenance: 'deepseek', jurisdiction: 'CN' })];
  // Server gate ON, but caller forces gate_ready:false ⇒ worker excluded ⇒ native.
  const r = await call('router_preview', deps({ candidateLanes: () => lanes, gateReady: true }), {
    category: 'bugfix',
    repo_class: 'public',
    sensitivity: 'normal',
    gate_ready: false,
  });
  assert.equal(r.structuredContent!.native as boolean, true);
});

test('preview reports native/disabled when routing is off (matches delegate)', async () => {
  const r = await call('router_preview', deps({ getEnabled: () => false }), { category: 'bugfix' });
  assert.notEqual(r.isError, true);
  assert.equal(r.structuredContent!.native as boolean, true);
  assert.equal(r.structuredContent!.disabled as boolean, true);
  assert.match(r.content[0]!.text, /DISABLED/);
});

test('preview requires a known category', async () => {
  const r1 = await call('router_preview', deps(), {});
  assert.equal(r1.isError, true);
  const r2 = await call('router_preview', deps(), { category: 'nonsense' });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0]!.text, /must be one of/);
});

test('preview rejects a non-boolean gate_ready instead of silently defaulting', async () => {
  const r = await call('router_preview', deps(), { category: 'bugfix', gate_ready: 'true' });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /must be a boolean/);
});

test('preview passes repo_class/sensitivity into the policy context', async () => {
  const lanes = [lane({ id: 'claude-native', native: true })];
  const r = await call('router_preview', deps({ candidateLanes: () => lanes }), {
    category: 'bugfix',
    repo_class: 'private',
    sensitivity: 'sensitive',
  });
  assert.deepEqual(r.structuredContent!.policyContext, { repo_class: 'private', sensitivity: 'sensitive' });
});

test('router_delegate and router_preview reject full_access without a model pin', async () => {
  const r1 = await call('router_delegate', deps(), { instruction: 'test', full_access: true });
  assert.equal(r1.isError, true);
  assert.match(r1.content[0]!.text, /full_access requires a model pin/);

  const r2 = await call('router_preview', deps(), { category: 'bugfix', full_access: true });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0]!.text, /full_access requires a model pin/);
});

test('preview using a PERSISTED lane-id grant elevates exactly that reader lane, and stored grant of a family-prefix of a DIFFERENT model does not elevate it', async () => {
  const targetReader = lane({ id: 'minimax-api', model: 'minimax-m3', trust_mode: 'reader', kind: 'api' });
  const otherReader = lane({ id: 'minimax-cheap-api', model: 'minimax-m3-cheap', trust_mode: 'reader', kind: 'api' });
  const lanes = [targetReader, otherReader];

  // Grant is for 'minimax-api'
  const grants = ['minimax-api'];
  
  const r = await call(
    'router_preview',
    deps({
      candidateLanes: () => lanes,
      getFullAccess: (ls) => {
        const projectGrantsLower = new Set(grants.map((x) => x.toLowerCase()));
        return (ls ?? lanes).filter((l) => projectGrantsLower.has(l.id.toLowerCase())).map((l) => l.id);
      },
      gateReady: true,
      readerEgress: true,
    }),
    {
      category: 'bugfix',
      repo_class: 'private',
      sensitivity: 'sensitive',
    }
  );

  assert.notEqual(r.isError, true);
  const decision = r.structuredContent!.decision as { laneId: string } | null;
  assert.ok(decision);
  assert.equal(decision.laneId, 'minimax-api');
});

test('delegate and preview compute IDENTICAL fullAccessLaneIds including exact-match decoy verification (FIX D)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-wiring-'));
  const lanesYaml = `lanes:
  - id: minimax-api
    kind: api
    model: MiniMax-M3
    trust_mode: reader
    costBasis: metered
    provenance: minimax
    jurisdiction: CN
    endpoint: http://localhost
    capability:
      bugfix: 0.8
    repo_read_attestation: true
  - id: minimax-cheap-api
    kind: api
    model: MiniMax-M3-cheap
    trust_mode: reader
    costBasis: subscription
    provenance: minimax
    jurisdiction: CN
    endpoint: http://localhost
    capability:
      bugfix: 0.6
    repo_read_attestation: true
  - id: claude-native
    kind: cli
    model: claude-opus
    trust_mode: full
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    native: true
    capability:
      bugfix: 0.95
`;
  writeFileSync(join(dir, 'lanes.yaml'), lanesYaml, 'utf8');
  writeFileSync(join(dir, 'full-access.json'), JSON.stringify({ 'wiring-test': ['minimax-api'] }), 'utf8');

  const env = {
    TOKENMAXED_LANES: join(dir, 'lanes.yaml'),
    TOKENMAXED_LEDGER: join(dir, 'ledger.jsonl'),
    TOKENMAXED_STATE: join(dir, 'state.json'),
    TOKENMAXED_FULL_ACCESS_STATE: join(dir, 'full-access.json'),
    TOKENMAXED_PRICES: fileURLToPath(new URL('../prices.seed.json', import.meta.url)),
    TOKENMAXED_PROJECT: 'wiring-test',
    TOKENMAXED_GATE_READY: 'true',
    TOKENMAXED_READER_EGRESS: 'true',
  };

  try {
    const serverDeps = makeServerDeps(env);
    
    // 1. Call router_preview via dispatch
    const previewRes = await dispatch(TOOLS, serverDeps, 'router_preview', {
      category: 'bugfix',
      repo_class: 'private',
      sensitivity: 'sensitive',
    });
    assert.ok(!previewRes.isError, JSON.stringify(previewRes));
    const previewIds = previewRes.structuredContent!.fullAccessLaneIds as string[];
    assert.ok(previewIds);
    assert.deepEqual(previewIds, ['minimax-api']);

    // 2. Call router_delegate via dispatch
    const delegateRes = await dispatch(TOOLS, serverDeps, 'router_delegate', {
      category: 'bugfix',
      instruction: 'test',
      repo_class: 'private',
      sensitivity: 'sensitive',
    });
    assert.notEqual(delegateRes.isError, true);
    const delegateIds = delegateRes.structuredContent!.fullAccessLaneIds as string[];
    assert.ok(delegateIds, JSON.stringify(delegateRes));
    assert.deepEqual(delegateIds, ['minimax-api']);

    // 3. Confirm both paths computed IDENTICAL fullAccessLaneIds
    assert.deepEqual(previewIds, delegateIds);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

test('YOLO: delegate and preview automatically elevate reader lanes in fullAccessLaneIds, scope to readers, block still drops', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-yolo-wiring-'));
  const lanesYaml = `lanes:
  - id: minimax-api
    kind: api
    model: MiniMax-M3
    trust_mode: reader
    costBasis: metered
    provenance: minimax
    jurisdiction: CN
    endpoint: http://localhost
    capability:
      bugfix: 0.99
    repo_read_attestation: true
    authHandle: minimax
  - id: deepseek-api
    kind: api
    model: deepseek-v3
    trust_mode: worker
    costBasis: metered
    provenance: deepseek
    jurisdiction: CN
    endpoint: http://localhost
    capability:
      bugfix: 0.7
    authHandle: deepseek

  - id: claude-native
    kind: cli
    model: claude-opus
    trust_mode: full
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    native: true
    capability:
      bugfix: 0.5

`;
  writeFileSync(join(dir, 'lanes.yaml'), lanesYaml, 'utf8');
  writeFileSync(join(dir, 'full-access.json'), JSON.stringify({}), 'utf8');
  writeFileSync(join(dir, 'yolo.json'), JSON.stringify({ 'wiring-test': true }), 'utf8');
  writeFileSync(join(dir, 'policy.yaml'), 'rules: []\n', 'utf8');

  const env = {
    TOKENMAXED_LANES: join(dir, 'lanes.yaml'),
    TOKENMAXED_POLICY: join(dir, 'policy.yaml'),
    TOKENMAXED_LEDGER: join(dir, 'ledger.jsonl'),
    TOKENMAXED_STATE: join(dir, 'state.json'),
    TOKENMAXED_YOLO_STATE: join(dir, 'yolo.json'),
    TOKENMAXED_FULL_ACCESS_STATE: join(dir, 'full-access.json'),
    TOKENMAXED_PRICES: fileURLToPath(new URL('../prices.seed.json', import.meta.url)),
    TOKENMAXED_PROJECT: 'wiring-test',
    TOKENMAXED_GATE_READY: 'true',
    TOKENMAXED_READER_EGRESS: 'true',
    TOKENMAXED_KEY_minimax: 'sk-minimax',
    TOKENMAXED_KEY_deepseek: 'sk-deepseek',
  };

  try {
    const serverDeps = makeServerDeps(env);

    // 1. Call router_preview via dispatch
    const previewRes = await dispatch(TOOLS, serverDeps, 'router_preview', {
      category: 'bugfix',
      repo_class: 'private',
      sensitivity: 'sensitive',
    });
    assert.ok(!previewRes.isError, JSON.stringify(previewRes));
    const previewIds = previewRes.structuredContent!.fullAccessLaneIds as string[];
    assert.ok(previewIds);
    // YOLO is ON, so minimax-api (reader) is elevated, but deepseek-api (worker) is not!
    assert.ok(previewIds.includes('minimax-api'));
    assert.ok(!previewIds.includes('deepseek-api'));
    // Since minimax-api is elevated and has bugfix capability (and we have no block), it should win
    const previewDecision = previewRes.structuredContent!.decision as { laneId: string } | null;
    assert.ok(previewDecision);
    assert.equal(previewDecision.laneId, 'minimax-api');

    // 2. Call router_delegate via dispatch
    const delegateRes = await dispatch(TOOLS, serverDeps, 'router_delegate', {
      category: 'bugfix',
      instruction: 'test',
      repo_class: 'private',
      sensitivity: 'sensitive',
    });
    assert.notEqual(delegateRes.isError, true);
    const delegateIds = delegateRes.structuredContent!.fullAccessLaneIds as string[];
    assert.ok(delegateIds, JSON.stringify(delegateRes));
    assert.ok(delegateIds.includes('minimax-api'));
    assert.ok(!delegateIds.includes('deepseek-api'));
    const delegateLaneId = delegateRes.structuredContent!.laneId as string;
    assert.equal(delegateLaneId, 'minimax-api');


    // 3. YOLO + explicit persisted grant union (deduped)
    writeFileSync(join(dir, 'full-access.json'), JSON.stringify({ 'wiring-test': ['minimax-api'] }), 'utf8');
    const serverDepsUnion = makeServerDeps(env);
    const previewResUnion = await dispatch(TOOLS, serverDepsUnion, 'router_preview', {
      category: 'bugfix',
      repo_class: 'private',
      sensitivity: 'sensitive',
    });
    assert.ok(!previewResUnion.isError);
    const unionIds = previewResUnion.structuredContent!.fullAccessLaneIds as string[];
    assert.deepEqual(unionIds, ['minimax-api']);

    // 4. Actually test a policy block rule for the reader lane under YOLO
    const policyYamlBlock = `rules:
  - trust_mode: reader
    verdict: block
`;
    writeFileSync(join(dir, 'policy.yaml'), policyYamlBlock, 'utf8');
    const serverDepsBlock = makeServerDeps(env);
    const previewResBlock = await dispatch(TOOLS, serverDepsBlock, 'router_preview', {
      category: 'bugfix',
      repo_class: 'private',
      sensitivity: 'sensitive',
    });
    assert.ok(!previewResBlock.isError);
    // minimax-api is blocked, so it should fall back to claude-native
    const blockDecision = previewResBlock.structuredContent!.decision as { laneId: string } | null;
    assert.ok(blockDecision);
    assert.equal(blockDecision.laneId, 'claude-native');

    // 5. Test disabledLaneIds under YOLO
    const policyYamlDisable = `disabledLaneIds:
  - minimax-api
`;
    writeFileSync(join(dir, 'policy.yaml'), policyYamlDisable, 'utf8');
    const serverDepsDisable = makeServerDeps(env);
    const previewResDisable = await dispatch(TOOLS, serverDepsDisable, 'router_preview', {
      category: 'bugfix',
      repo_class: 'private',
      sensitivity: 'sensitive',
    });
    assert.ok(!previewResDisable.isError);
    const disableDecision = previewResDisable.structuredContent!.decision as { laneId: string } | null;
    assert.ok(disableDecision);
    assert.equal(disableDecision.laneId, 'claude-native');

    // 6. YOLO-off byte-identical case
    writeFileSync(join(dir, 'full-access.json'), JSON.stringify({}), 'utf8');
    writeFileSync(join(dir, 'yolo.json'), JSON.stringify({ 'wiring-test': false }), 'utf8');
    writeFileSync(join(dir, 'policy.yaml'), 'rules: []\n', 'utf8');
    const serverDepsYoloOff = makeServerDeps(env);
    const previewResYoloOff = await dispatch(TOOLS, serverDepsYoloOff, 'router_preview', {
      category: 'bugfix',
      repo_class: 'private',
      sensitivity: 'sensitive',
    });
    assert.ok(!previewResYoloOff.isError);
    const yoloOffIds = previewResYoloOff.structuredContent!.fullAccessLaneIds as string[];
    assert.ok(!yoloOffIds || yoloOffIds.length === 0);
    const yoloOffDecision = previewResYoloOff.structuredContent!.decision;
    assert.ok(yoloOffDecision);
    const expectedDecision = {
      laneId: 'claude-native',
      reason: 'Selected claude-native (claude-opus) for bugfix: capability 0.50 at subscription cost.',
      scores: [
        {
          laneId: 'claude-native',
          score: 0.45,
          factors: {
            capability: 0.5,
            costPenalty: 0.05,
            capPenalty: 0,
            declared: 0.5,
            evidenceN: 0
          }
        }
      ],
      policyVerdict: 'force-trusted'
    };
    assert.equal(JSON.stringify(yoloOffDecision), JSON.stringify(expectedDecision));

  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});


test('router_set_policy tool sets, clears, and validates policy', async () => {
  let policySet: string | undefined = undefined;
  const d = deps({
    setRoutingPolicy: (p) => { policySet = p; },
  });

  // Valid policy
  let res = await call('router_set_policy', d, { policy: 'preserve-frontier' });
  assert.notEqual(res.isError, true);
  assert.equal(policySet, 'preserve-frontier');

  // Clear policy using 'off'
  res = await call('router_set_policy', d, { policy: 'off' });
  assert.notEqual(res.isError, true);
  assert.equal(policySet, undefined);

  // Clear policy using 'clear'
  res = await call('router_set_policy', d, { policy: 'clear' });
  assert.notEqual(res.isError, true);
  assert.equal(policySet, undefined);

  // Reject invalid policy
  res = await call('router_set_policy', d, { policy: 'invalid-policy-name' });
  assert.equal(res.isError, true);
});

test('delegate rejects invalid policy below tool boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-wiring-policy-'));
  const lanesYaml = `lanes:\n  - id: minimax-api\n    kind: api\n    model: MiniMax-M3\n    trust_mode: reader\n    costBasis: metered\n    provenance: minimax\n    jurisdiction: CN\n    endpoint: http://localhost\n    capability:\n      bugfix: 0.8\n`;
  writeFileSync(join(dir, 'lanes.yaml'), lanesYaml, 'utf8');

  const env = {
    TOKENMAXED_LANES: join(dir, 'lanes.yaml'),
    TOKENMAXED_LEDGER: join(dir, 'ledger.jsonl'),
    TOKENMAXED_STATE: join(dir, 'state.json'),
    TOKENMAXED_PRICES: fileURLToPath(new URL('../prices.seed.json', import.meta.url)),
    TOKENMAXED_PROJECT: 'wiring-policy-test',
  };

  try {
    const serverDeps = makeServerDeps(env);
    await assert.rejects(async () => {
      await serverDeps.delegate({
        category: 'bugfix',
        instruction: 'test instruction',
        policy: 'invalid-policy-name' as any,
      });
    }, /Invalid routing policy/);

    await assert.rejects(async () => {
      await serverDeps.delegate({
        category: 'bugfix',
        instruction: 'test instruction',
        policy: '' as any,
      });
    }, /Invalid routing policy/);

    await assert.rejects(async () => {
      await serverDeps.delegate({
        category: 'bugfix',
        instruction: 'test instruction',
        policy: '   ' as any,
      });
    }, /Invalid routing policy/);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

test('router_preview and router_status are byte-identical to pre-feature shapes when no policy is explicit', async () => {
  const lanes = [
    lane({ id: 'cheap', capability: { docs: 0.7 }, costBasis: 'subscription' }),
    lane({ id: 'mid', capability: { docs: 0.85 }, costBasis: 'subscription' }),
  ];

  // Case 1: No explicit policy set (neither request policy, nor project policy, nor env policy)
  const dDefault = deps({
    candidateLanes: () => lanes,
    routingPolicy: () => 'balanced',
    routingPolicyExplicit: () => false,
  });

  const statusResDefault = await call('router_status', dDefault);
  assert.notEqual(statusResDefault.isError, true);
  // Status text should NOT contain "Active routing policy:"
  assert.equal(statusResDefault.content?.[0]?.text?.includes('Active routing policy:'), false);

  const previewResDefault = await call('router_preview', dDefault, { category: 'docs' });
  assert.notEqual(previewResDefault.isError, true);
  // Preview text should NOT contain "  policy:"
  assert.equal(previewResDefault.content?.[0]?.text?.includes('  policy:'), false);

  // Case 2: Legacy TOKENMAXED_TIERED=true (tieredStrategy: 'tiered') without explicit policy
  const dLegacy = deps({
    candidateLanes: () => lanes,
    tieredStrategy: 'tiered',
    tierFloor: 0.6,
    routingPolicy: () => 'cheapest',
    routingPolicyExplicit: () => false,
  });

  const statusResLegacy = await call('router_status', dLegacy);
  assert.notEqual(statusResLegacy.isError, true);
  assert.equal(statusResLegacy.content?.[0]?.text?.includes('Active routing policy:'), false);

  const previewResLegacy = await call('router_preview', dLegacy, { category: 'docs' });
  assert.notEqual(previewResLegacy.isError, true);
  assert.equal(previewResLegacy.content?.[0]?.text?.includes('  policy:'), false);

  // Case 3: Explicit policy set (should render policy lines)
  const dExplicit = deps({
    candidateLanes: () => lanes,
    routingPolicy: () => 'preserve-frontier',
    routingPolicyExplicit: () => true,
  });

  const statusResExplicit = await call('router_status', dExplicit);
  assert.notEqual(statusResExplicit.isError, true);
  assert.equal(statusResExplicit.content?.[0]?.text?.includes('Active routing policy: preserve-frontier'), true);

  const previewResExplicit = await call('router_preview', dExplicit, { category: 'docs' });
  assert.notEqual(previewResExplicit.isError, true);
  assert.equal(previewResExplicit.content?.[0]?.text?.includes('  policy: preserve-frontier active'), true);
});

test('router_preview: forecast renders correctly when instruction is supplied', async () => {
  const lanes = [
    lane({ id: 'metered-lane', model: 'gpt-5.5', costBasis: 'metered' }),
  ];
  const priceTable = {
    schema_version: 1,
    frontier_model: 'claude-opus-4-7',
    models: {
      'gpt-5.5': { inputPer1M: 10, outputPer1M: 30 },
    },
  };
  const d = deps({
    candidateLanes: () => lanes,
    loadPriceTable: () => priceTable as any,
  });

  const res = await call('router_preview', d, {
    category: 'bugfix',
    instruction: 'hello world', // 3 tokens
  });

  assert.notEqual(res.isError, true);
  const text = res.content?.[0]?.text ?? '';
  assert.ok(text.includes('forecast: ~3 input tok · ~<$0.0001 metered (input only, output extra)'));
  assert.equal((res.structuredContent as any)?.forecast?.estTokensIn, 3);
  assert.equal((res.structuredContent as any)?.forecast?.estCostUsd, 0.00003);
});

test('router_preview: forecast is completely omitted when instruction is absent', async () => {
  const lanes = [
    lane({ id: 'metered-lane', model: 'gpt-5.5', costBasis: 'metered' }),
  ];
  const d = deps({
    candidateLanes: () => lanes,
  });

  const res = await call('router_preview', d, {
    category: 'bugfix',
  });

  assert.notEqual(res.isError, true);
  const text = res.content?.[0]?.text ?? '';
  assert.equal(text.includes('forecast:'), false);
  assert.equal((res.structuredContent as any)?.forecast, undefined);
});

test('router_preview: forecast handles files attachment correctly', async () => {
  const lanes = [
    lane({ id: 'metered-lane', model: 'gpt-5.5', costBasis: 'metered' }),
  ];
  const priceTable = {
    schema_version: 1,
    frontier_model: 'claude-opus-4-7',
    models: {
      'gpt-5.5': { inputPer1M: 10, outputPer1M: 30 },
    },
  };
  const d = deps({
    candidateLanes: () => lanes,
    loadPriceTable: () => priceTable as any,
    readRepoFiles: (paths: readonly string[]) => {
      assert.deepEqual(paths, ['foo.js']);
      return {
        attachments: [{ content: 'extra file content', provenance: 'host-authored', repo_derived: true }],
        skipped: [],
      };
    },
  });

  // instruction is 'hello world' (11 chars -> 3 tokens)
  // foo.js adds 'extra file content' (18 chars -> 5 tokens)
  // combined is 'hello world\nextra file content' (30 chars -> 8 tokens)
  const res = await call('router_preview', d, {
    category: 'bugfix',
    instruction: 'hello world',
    files: ['foo.js'],
  });

  assert.notEqual(res.isError, true);
  const text = res.content?.[0]?.text ?? '';
  assert.ok(text.includes('forecast: ~8 input tok · ~<$0.0001 metered (input only, output extra)'));
  assert.equal((res.structuredContent as any)?.forecast?.estTokensIn, 8);
});

test('router_preview: forecast appends skipped files note', async () => {
  const lanes = [
    lane({ id: 'metered-lane', model: 'gpt-5.5', costBasis: 'metered' }),
  ];
  const d = deps({
    candidateLanes: () => lanes,
    readRepoFiles: () => ({
      attachments: [],
      skipped: [{ path: 'missing.js', reason: 'not found' }],
    }),
  });

  const res = await call('router_preview', d, {
    category: 'bugfix',
    instruction: 'hello world',
    files: ['missing.js'],
  });

  assert.notEqual(res.isError, true);
  const text = res.content?.[0]?.text ?? '';
  assert.ok(text.includes('missing.js: not found'));
});

test('router_preview: byte-identity full-serialization baseline comparison', async () => {
  const lanes = [
    lane({ id: 'cheap', capability: { docs: 0.7 }, costBasis: 'subscription' }),
    lane({ id: 'mid', capability: { docs: 0.85 }, costBasis: 'subscription' }),
  ];
  const d = deps({
    candidateLanes: () => lanes,
    routingPolicy: () => 'balanced',
    routingPolicyExplicit: () => false,
  });

  const res = await call('router_preview', d, { category: 'docs' });

  const expectedText = [
    'category "docs" → lane "mid"',
    '  cli · m · trust=full',
    '  policy verdict: force-trusted',
    '  fingerprint: unknown · context: small · tools: low · impl · security: no · blast: narrow',
    '  why: Selected mid (m) for docs: capability 0.85 at subscription cost.'
  ].join('\n');

  const expectedStructured = {
    category: 'docs',
    gateReady: true,
    policyContext: {},
    decision: {
      laneId: 'mid',
      reason: 'Selected mid (m) for docs: capability 0.85 at subscription cost.',
      scores: [
        {
          laneId: 'mid',
          score: 0.7999999999999999,
          factors: {
            capability: 0.85,
            costPenalty: 0.05,
            capPenalty: 0,
            declared: 0.85,
            evidenceN: 0
          }
        },
        {
          laneId: 'cheap',
          score: 0.6499999999999999,
          factors: {
            capability: 0.7,
            costPenalty: 0.05,
            capPenalty: 0,
            declared: 0.7,
            evidenceN: 0
          }
        }
      ],
      policyVerdict: 'force-trusted'
    },
    verdict: 'force-trusted',
    native: false,
    yolo: false,
    fullAccessLaneIds: [],
    fingerprint: {
      language: { lang: 'unknown', confidence: 0 },
      contextSizeBand: 'small',
      toolNeed: 'low',
      planVsImpl: 'impl',
      securitySensitive: false,
      blastRadius: 'narrow'
    }
  };

  const expectedResult = {
    content: [{ type: 'text', text: expectedText }],
    structuredContent: expectedStructured
  };
  assert.equal(JSON.stringify(res), JSON.stringify(expectedResult));
});

test('router_preview: forecast renders correctly with overflow/negative prices', async () => {
  // 1. Overflow price
  const lanesOverflow = [
    lane({ id: 'overflow-lane', model: 'gpt-5.5', costBasis: 'metered' }),
  ];
  const priceTableOverflow = {
    schema_version: 1,
    frontier_model: 'claude-opus-4-7',
    models: {
      'gpt-5.5': { inputPer1M: Number.MAX_VALUE, outputPer1M: 0 },
    },
  };
  const dOverflow = deps({
    candidateLanes: () => lanesOverflow,
    loadPriceTable: () => priceTableOverflow as any,
  });

  const resOverflow = await call('router_preview', dOverflow, {
    category: 'bugfix',
    instruction: 'hello world', // 3 tokens
  });

  assert.notEqual(resOverflow.isError, true);
  const textOverflow = resOverflow.content?.[0]?.text ?? '';
  assert.ok(!textOverflow.includes('$Infinity'));
  assert.ok(!textOverflow.includes('$NaN'));
  assert.ok(!textOverflow.includes('$-'));
  assert.equal((resOverflow.structuredContent as any)?.forecast?.estCostUsd, undefined);

  // 2. Negative price
  const lanesNegative = [
    lane({ id: 'negative-lane', model: 'gpt-5.5', costBasis: 'metered' }),
  ];
  const priceTableNegative = {
    schema_version: 1,
    frontier_model: 'claude-opus-4-7',
    models: {
      'gpt-5.5': { inputPer1M: -10, outputPer1M: 0 },
    },
  };
  const dNegative = deps({
    candidateLanes: () => lanesNegative,
    loadPriceTable: () => priceTableNegative as any,
  });

  const resNegative = await call('router_preview', dNegative, {
    category: 'bugfix',
    instruction: 'hello world', // 3 tokens
  });

  assert.notEqual(resNegative.isError, true);
  const textNegative = resNegative.content?.[0]?.text ?? '';
  assert.ok(!textNegative.includes('$Infinity'));
  assert.ok(!textNegative.includes('$NaN'));
  assert.ok(!textNegative.includes('$-'));
  assert.equal((resNegative.structuredContent as any)?.forecast?.estCostUsd, undefined);
});

test('router_doctor runs diagnostics and formats findings sorted by severity', async () => {
  // 1. Healthy setup (no findings)
  const dHealthy = deps({
    doctor: async () => ({ findings: [] }),
  });
  const resHealthy = await call('router_doctor', dHealthy);
  assert.notEqual(resHealthy.isError, true);
  assert.match(resHealthy.content[0]!.text, /no problems found/);
  assert.deepEqual(resHealthy.structuredContent!.findings, []);

  // 2. Setup with multiple findings (errors, warnings, infos)
  const findings: any[] = [
    { severity: 'warn', title: 'Stale model', detail: 'Using old model', fix: 'Pin newer' },
    { severity: 'error', title: 'Malformed config', detail: 'Invalid yaml', fix: 'Fix yaml' },
    { severity: 'info', title: 'Plugin suggestion', detail: 'Use CLI plugin', fix: 'Check plugin url' },
  ];
  const dFindings = deps({
    doctor: async () => ({ findings }),
  });
  const resFindings = await call('router_doctor', dFindings);
  assert.notEqual(resFindings.isError, true);
  const text = resFindings.content[0]!.text;

  // Sorted severity order: error, warn, info
  assert.match(text, /✗ \[ERROR\] Malformed config/);
  assert.match(text, /⚠ \[WARN\] Stale model/);
  assert.match(text, /ℹ \[INFO\] Plugin suggestion/);

  // Assert structured findings are returned
  assert.deepEqual(
    (resFindings.structuredContent!.findings as any[]).map((f) => f.title),
    ['Malformed config', 'Stale model', 'Plugin suggestion']
  );
});

test('router_feedback: records user feedback (good/wrong-model/bad-output/too-slow) and targets last offload or explicit lane+category', async () => {
  const ledger: LedgerEvent[] = [
    taskEvent({ ts: new Date().toISOString(), task_id: 't-last', laneId: 'lane-a', model: 'model-a', category: 'bugfix', attempt: 0, status: 'ok' }),
  ];
  const outcomesAppended: OutcomeEventInput[] = [];
  const d = deps({
    readLedger: () => ledger,
    allLanes: () => [lane({ id: 'lane-a', model: 'model-a' }), lane({ id: 'lane-b', model: 'model-b' })],
    appendOutcome: (input) => {
      outcomesAppended.push(input);
      return { ...input, event_type: 'outcome', id: 'new-id', seq: 2, ts: new Date().toISOString() } as any;
    },
    newId: () => 'uid-123',
  });

  // 1. last offload, good feedback
  const r1 = await call('router_feedback', d, { verdict: 'good' });
  assert.notEqual(r1.isError, true);
  assert.equal(outcomesAppended.length, 1);
  const ev1 = outcomesAppended[0]!;
  assert.equal(ev1.subject_id, 't-last');
  assert.equal(ev1.subject_lane_id, 'lane-a');
  assert.equal(ev1.subject_model, 'model-a');
  assert.equal(ev1.category, 'bugfix');
  assert.equal(ev1.verdict, 'pass');
  assert.equal(ev1.voter, 'user');
  assert.equal(ev1.reviewer_lane_id, 'user');
  assert.equal(ev1.reviewer_model, 'user');

  // 2. last offload, wrong-model feedback (maps to fail)
  const r2 = await call('router_feedback', d, { verdict: 'wrong-model' });
  assert.equal(outcomesAppended[1]!.verdict, 'fail');

  // 3. last offload, bad-output feedback (maps to fail)
  const r3 = await call('router_feedback', d, { verdict: 'bad-output' });
  assert.equal(outcomesAppended[2]!.verdict, 'fail');

  // 4. last offload, too-slow feedback (maps to needs-rework)
  const r4 = await call('router_feedback', d, { verdict: 'too-slow' });
  assert.equal(outcomesAppended[3]!.verdict, 'needs-rework');

  // 5. explicit targeting
  const r5 = await call('router_feedback', d, { verdict: 'good', lane: 'lane-b', category: 'codegen', difficulty: 'easy' });
  assert.notEqual(r5.isError, true);
  const ev5 = outcomesAppended[4]!;
  assert.equal(ev5.subject_lane_id, 'lane-b');
  assert.equal(ev5.subject_model, 'model-b');
  assert.equal(ev5.category, 'codegen');
  assert.equal(ev5.difficulty, 'easy');
  assert.equal(ev5.verdict, 'pass');
  assert.equal(ev5.voter, 'user');
});

test('router_set_freeze: toggles freeze learning state and builds observed capability accordingly', async () => {
  let frozenState = false;
  const d = deps({
    getFrozen: () => frozenState,
    setFrozen: (f) => { frozenState = f; },
    readLedger: () => [],
  });

  // check freeze on
  const r1 = await call('router_set_freeze', d, { enabled: true });
  assert.notEqual(r1.isError, true);
  assert.equal(frozenState, true);
  assert.match(r1.content[0]!.text, /FROZEN/);

  // check status reports it
  const rStatus = await call('router_status', d);
  assert.match(rStatus.content[0]!.text, /Capability learning is frozen/);

  // check freeze off
  const r2 = await call('router_set_freeze', d, { enabled: false });
  assert.notEqual(r2.isError, true);
  assert.equal(frozenState, false);
  assert.match(r2.content[0]!.text, /UNFROZEN/);
});

test('freeze: suppresses observed overlays so routing uses declared capability only', async () => {
  const strong = lane({ id: 'strong', model: 'strong-m', costBasis: 'subscription', capability: { bugfix: 0.85 } });
  const cheap = lane({ id: 'cheap', model: 'cheap-m', costBasis: 'local', capability: { bugfix: 0.6 } });
  const lanes = [strong, cheap];
  const overlay = { 'cheap-m': { bugfix: { rate: 1.0, n: 100_000 } } };

  // 1. With learning on and not frozen, cheap lane wins because overlay is used
  const dNotFrozen = deps({
    candidateLanes: () => lanes,
    observedCapabilityByModel: () => overlay,
    getFrozen: () => false,
  });
  const r1 = await call('router_preview', dNotFrozen, { category: 'bugfix' });
  assert.equal((r1.structuredContent!.decision as { laneId: string }).laneId, 'cheap');

  // 2. With learning on but frozen, strong lane wins because overlay is suppressed
  const dFrozen = deps({
    candidateLanes: () => lanes,
    observedCapabilityByModel: () => overlay,
    getFrozen: () => true,
  });
  const r2 = await call('router_preview', dFrozen, { category: 'bugfix' });
  assert.equal((r2.structuredContent!.decision as { laneId: string }).laneId, 'strong');
  assert.match(r2.content[0]!.text, /learning: frozen for this project/);
});

test('router_feedback: edge cases and validations', async () => {
  const allLanes = [lane({ id: 'lane-a', model: 'model-a' })];
  const dEmptyLedger = deps({
    readLedger: () => [],
    allLanes: () => allLanes,
  });

  // 1. Missing verdict
  const rMissingVerdict = await call('router_feedback', dEmptyLedger, {} as any);
  assert.equal(rMissingVerdict.isError, true);
  assert.match(rMissingVerdict.content[0]!.text, /"verdict" is required/);

  // 2. Bad verdict enum
  const rBadVerdict = await call('router_feedback', dEmptyLedger, { verdict: 'excellent' });
  assert.equal(rBadVerdict.isError, true);
  assert.match(rBadVerdict.content[0]!.text, /must be one of/);

  // 3. Blank lane
  const rBlankLane = await call('router_feedback', dEmptyLedger, { verdict: 'good', lane: '  ', category: 'bugfix' });
  assert.equal(rBlankLane.isError, true);
  assert.match(rBlankLane.content[0]!.text, /cannot be blank/);

  // 4. Invalid category
  const rBadCat = await call('router_feedback', dEmptyLedger, { verdict: 'good', lane: 'lane-a', category: 'writing' });
  assert.equal(rBadCat.isError, true);
  assert.match(rBadCat.content[0]!.text, /Invalid category/);

  // 5. Partial target (lane without category)
  const rPartialLane = await call('router_feedback', dEmptyLedger, { verdict: 'good', lane: 'lane-a' });
  assert.equal(rPartialLane.isError, true);
  assert.match(rPartialLane.content[0]!.text, /requires both/);

  // 6. Unknown lane
  const rUnknownLane = await call('router_feedback', dEmptyLedger, { verdict: 'good', lane: 'unknown-lane', category: 'bugfix' });
  assert.equal(rUnknownLane.isError, true);
  assert.match(rUnknownLane.content[0]!.text, /is not configured/);

  // 7. Native-only ledger
  const dNativeOnly = deps({
    readLedger: () => [taskEvent({ ts: new Date().toISOString(), laneId: 'native', model: 'native', category: 'bugfix', status: 'native' })],
    allLanes: () => allLanes,
  });
  const rNativeOnly = await call('router_feedback', dNativeOnly, { verdict: 'good' });
  assert.equal(rNativeOnly.isError, true);
  assert.match(rNativeOnly.content[0]!.text, /no non-native task events/);

  // 8. Empty ledger
  const rEmpty = await call('router_feedback', dEmptyLedger, { verdict: 'good' });
  assert.equal(rEmpty.isError, true);
  assert.match(rEmpty.content[0]!.text, /ledger is empty/);

  // 9. Unreadable ledger
  const dUnreadable = deps({
    readLedger: () => { throw new Error('disk failure'); },
    allLanes: () => allLanes,
  });
  const rUnreadable = await call('router_feedback', dUnreadable, { verdict: 'good' });
  assert.equal(rUnreadable.isError, true);
  assert.match(rUnreadable.content[0]!.text, /Failed to read ledger/);
});

test('router_set_freeze: validation of missing freeze boolean', async () => {
  const d = deps({
    getFrozen: () => false,
    setFrozen: () => {},
  });
  const r = await call('router_set_freeze', d, {} as any);
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /"enabled" is required/);
});

test('preview includes user feedback provenance annotation in why reasoning only when it actually contributes', async () => {
  const strong = lane({ id: 'strong', model: 'strong-m', costBasis: 'subscription', capability: { bugfix: 0.85 } });
  const cheap = lane({ id: 'cheap', model: 'cheap-m', costBasis: 'local', capability: { bugfix: 0.6 } });
  const lanes = [strong, cheap];
  const overlay = { 'cheap-m': { bugfix: { rate: 1.0, n: 100_000 } } };

  // 1. Contributing user feedback -> should show "(includes your feedback)"
  const dContributing = deps({
    candidateLanes: () => lanes,
    observedCapabilityByModel: () => overlay,
    getFrozen: () => false,
    readLedger: () => [
      {
        event_type: 'outcome',
        subject_type: 'router_task',
        task_id: 't1',
        attempt: 0,
        seq: 1,
        category: 'bugfix',
        subject_lane_id: 'cheap',
        subject_model: 'cheap-m',
        subject_model_resolved: 'cheap-m',
        verdict: 'pass',
        voter: 'user',
        ts: new Date(FIXED_NOW).toISOString(),
      } as any,
    ],
  });

  const res1 = await call('router_preview', dContributing, { category: 'bugfix' });
  assert.notEqual(res1.isError, true);
  assert.match(res1.content[0]!.text, /learned \(includes your feedback\)/);
  assert.match((res1.structuredContent!.decision as any).reason, /learned \(includes your feedback\)/);

  // 2. Superseded user feedback (later sequence review by model wins) -> should NOT show "(includes your feedback)"
  const dSuperseded = deps({
    candidateLanes: () => lanes,
    observedCapabilityByModel: () => overlay,
    getFrozen: () => false,
    readLedger: () => [
      {
        event_type: 'outcome',
        subject_type: 'router_task',
        task_id: 't1',
        attempt: 0,
        seq: 1,
        category: 'bugfix',
        subject_lane_id: 'cheap',
        subject_model: 'cheap-m',
        subject_model_resolved: 'cheap-m',
        verdict: 'fail',
        voter: 'user', // user outcome at seq 1
        ts: new Date(FIXED_NOW).toISOString(),
      } as any,
      {
        event_type: 'outcome',
        subject_type: 'router_task',
        task_id: 't1',
        attempt: 0,
        seq: 2, // higher seq model review supersedes user
        category: 'bugfix',
        subject_lane_id: 'cheap',
        subject_model: 'cheap-m',
        subject_model_resolved: 'cheap-m',
        verdict: 'pass',
        voter: 'reviewer_model',
        ts: new Date(FIXED_NOW).toISOString(),
      } as any,
    ],
  });

  const res2 = await call('router_preview', dSuperseded, { category: 'bugfix' });
  assert.notEqual(res2.isError, true);
  assert.doesNotMatch(res2.content[0]!.text, /includes your feedback/);
  assert.doesNotMatch((res2.structuredContent!.decision as any).reason, /includes your feedback/);

  // 3. Decayed user feedback (old user outcome decayed to weight 0) -> should NOT show "(includes your feedback)"
  const dDecayed = deps({
    candidateLanes: () => lanes,
    observedCapabilityByModel: () => overlay,
    getFrozen: () => false,
    readLedger: () => [
      {
        event_type: 'outcome',
        subject_type: 'router_task',
        task_id: 't1',
        attempt: 0,
        seq: 1,
        category: 'bugfix',
        subject_lane_id: 'cheap',
        subject_model: 'cheap-m',
        subject_model_resolved: 'cheap-m',
        verdict: 'pass',
        voter: 'user',
        ts: '1900-01-01T00:00:00.000Z', // decayed to weight 0
      } as any,
    ],
  });

  const res3 = await call('router_preview', dDecayed, { category: 'bugfix' });
  assert.notEqual(res3.isError, true);
  assert.doesNotMatch(res3.content[0]!.text, /includes your feedback/);
  assert.doesNotMatch((res3.structuredContent!.decision as any).reason, /includes your feedback/);

  // 4. Model containing separator character (handled identically to core since we reuse it)
  const sepLane = lane({ id: 'sep-l', model: 'cheap\u0000m', costBasis: 'local', capability: { bugfix: 0.6 } });
  const sepLanes = [strong, sepLane];
  const sepOverlay = { 'cheap\u0000m': { bugfix: { rate: 1.0, n: 100_000 } } };
  const dSep = deps({
    candidateLanes: () => sepLanes,
    observedCapabilityByModel: () => sepOverlay,
    getFrozen: () => false,
    readLedger: () => [
      {
        event_type: 'outcome',
        subject_type: 'router_task',
        task_id: 't1',
        attempt: 0,
        seq: 1,
        category: 'bugfix',
        subject_lane_id: 'sep-l',
        subject_model: 'cheap\u0000m',
        subject_model_resolved: 'cheap\u0000m',
        verdict: 'pass',
        voter: 'user',
        ts: new Date(FIXED_NOW).toISOString(),
      } as any,
    ],
  });

  const res4 = await call('router_preview', dSep, { category: 'bugfix' });
  assert.notEqual(res4.isError, true);
  assert.match(res4.content[0]!.text, /learned \(includes your feedback\)/);
  assert.match((res4.structuredContent!.decision as any).reason, /learned \(includes your feedback\)/);
});

test('router_plan tool executes correctly and matches CLI/core behavior', async () => {
  const strong = lane({ id: 'strong-lane', model: 'claude-opus-4-7', costBasis: 'metered', capability: { feature: 1.0 } });
  const sub = lane({ id: 'sub-lane', model: 'claude-haiku', costBasis: 'subscription', capability: { boilerplate: 0.9 } });
  const metered = lane({ id: 'metered-lane', model: 'gpt-5.5', costBasis: 'metered', capability: { bugfix: 0.9 } });
  const local = lane({ id: 'local-lane', model: 'llama3', costBasis: 'local', capability: { feature: 0.85 } });
  const lanes = [strong, sub, metered, local];

  const mockEvents = [
    ...Array.from({ length: 9 }, (_, i) => ({
      event_type: 'task',
      schema_version: 2,
      id: `t-${i}`,
      seq: i,
      ts: new Date(FIXED_NOW).toISOString(),
      task_id: `t-${i}`,
      attempt: 0,
      category: 'feature',
      laneId: 'strong-lane',
      model: 'claude-opus-4-7',
      trust_mode: 'full',
      provenance: 'anthropic',
      status: 'ok',
      tokens_in: 1000,
      tokens_out: 500,
      tokens_estimated: false,
      actual_cost: 0.5,
      frontier_cost: 0.5,
      metered_spent: 0.5,
      frontier_avoided: 0,
      metered_avoided: 0,
      policy_verdict: 'allow',
    } as any)),
    {
      event_type: 'task',
      schema_version: 2,
      id: 't-9',
      seq: 9,
      ts: new Date(FIXED_NOW).toISOString(),
      task_id: 't-9',
      attempt: 0,
      category: 'boilerplate',
      laneId: 'sub-lane',
      model: 'claude-haiku',
      trust_mode: 'full',
      provenance: 'anthropic',
      status: 'ok',
      tokens_in: 1000,
      tokens_out: 500,
      tokens_estimated: false,
      actual_cost: 0,
      frontier_cost: 0.05,
      metered_spent: 0,
      frontier_avoided: 0.05,
      metered_avoided: 0.05,
      policy_verdict: 'allow',
    } as any,
    {
      event_type: 'task',
      schema_version: 2,
      id: 't-10',
      seq: 10,
      ts: new Date(FIXED_NOW).toISOString(),
      task_id: 't-10',
      attempt: 0,
      category: 'bugfix',
      laneId: 'metered-lane',
      model: 'gpt-5.5',
      trust_mode: 'full',
      provenance: 'openai',
      status: 'ok',
      tokens_in: 1000,
      tokens_out: 500,
      tokens_estimated: false,
      actual_cost: 0.2,
      frontier_cost: 0.05,
      metered_spent: 0.2,
      frontier_avoided: -0.15,
      metered_avoided: -0.15,
      policy_verdict: 'allow',
    } as any,
  ];

  const priceTable: PriceTable = {
    schema_version: 1,
    frontier_model: 'claude-opus-4-7',
    models: {
      'claude-opus-4-7': { inputPer1M: 15, outputPer1M: 75 },
      'gpt-5.5': { inputPer1M: 10, outputPer1M: 30 },
      'claude-haiku': { inputPer1M: 0.25, outputPer1M: 1.25 },
      'llama3': { inputPer1M: 0, outputPer1M: 0 },
    },
  };

  const d = deps({
    allLanes: () => lanes,
    readLedger: () => mockEvents,
    loadPriceTable: () => priceTable,
    now: () => FIXED_NOW,
  });

  const res = await call('router_plan', d);
  assert.notEqual(res.isError, true);
  assert.match(res.content[0]!.text, /Plan Optimization Advisory \(routed-share only — not your total usage\)/);
  assert.match(res.content[0]!.text, /total routed offloads: 11 routed attempts \(routed-share only\)/);

  // Verify stats printed in output with routed-share separation (FIX D)
  assert.match(res.content[0]!.text, /strong-lane/);
  assert.match(res.content[0]!.text, /delivered successes: 9 successes \(routed-share only\)/);
  assert.match(res.content[0]!.text, /routed attempts: 9 attempts \(81.8% of total routed attempts\) \(routed-share only\)/);

  // Verify category qualifier (FIX D)
  assert.match(res.content[0]!.text, /categories: feature \(9 routed attempts\) \(routed-share only\)/);

  // Verify frontier breakdown qualifier (FIX D)
  assert.match(res.content[0]!.text, /feature: 9 routed attempts \(100.0% of lane's routed attempts\) \(routed-share only\)/);

  // Underused suggestion
  assert.match(res.content[0]!.text, /Underused lane: sub-lane/);

  // Frontier conservation suggestion
  assert.match(res.content[0]!.text, /Frontier-conservation: strong-lane \(feature\)/);

  // Metered spend suggestion
  assert.match(res.content[0]!.text, /Metered spend: metered-lane/);

  // Verify structured scope-metadata fields are present (FIX D)
  const structured = res.structuredContent as any;
  assert.equal(structured.frontierCategoryBreakdownScope, 'routed attempts per frontier lane');
  assert.deepEqual(structured.frontierCategoryBreakdownRoutedAttempts, structured.frontierCategoryBreakdown);
  const stats = structured.laneStats['strong-lane'];
  assert.equal(stats.shareScope, 'routed-share only');
  assert.equal(stats.sharePercentageOfRoutedAttempts, stats.share);
  assert.equal(stats.categoryDistributionScope, 'routed attempts');
  assert.deepEqual(stats.categoryDistributionRoutedAttempts, stats.categoryDistribution);
});

test('router_plan handles empty/sparse ledger gracefully', async () => {
  const dEmpty = deps({
    allLanes: () => [],
    readLedger: () => [],
    now: () => FIXED_NOW,
  });
  const res = await call('router_plan', dEmpty);
  assert.notEqual(res.isError, true);
  assert.match(res.content[0]!.text, /not enough routed history to advise yet \(need more offloads\)/);
});

test('router_plan handles ledger read error gracefully', async () => {
  const dError = deps({
    readLedger: () => { throw new Error('Ledger file is corrupt in path /usr/local/var/log'); },
    now: () => FIXED_NOW,
  });
  const res = await call('router_plan', dError);
  assert.notEqual(res.isError, true);
  assert.match(res.content[0]!.text, /Could not read the ledger. No plan optimization advice is available./);

  // Assert rendered text does not contain the thrown ledger string or path (Fix 2)
  assert.doesNotMatch(res.content[0]!.text, /Ledger file is corrupt|\/usr\/local\/var\/log/);

  // Assert structured output is strictly error-only (Fix 1)
  assert.deepEqual(res.structuredContent, {
    error: true,
    message: 'could not read the ledger',
  });
});

test('router_plan handles throwing loadPriceTable/analyzePlan gracefully without leaking message', async () => {
  // Case 1: loadPriceTable throws (leaks nothing)
  const dThrowing = deps({
    allLanes: () => [],
    readLedger: () => [
      ...Array.from({ length: 10 }, (_, i) => ({
        event_type: 'task',
        schema_version: 2,
        id: `t-${i}`,
        seq: i,
        ts: new Date(FIXED_NOW).toISOString(),
        task_id: `t-${i}`,
        attempt: 0,
        category: 'feature',
        laneId: 'strong-lane',
        model: 'claude-opus-4-7',
        status: 'ok',
      } as any))
    ],
    loadPriceTable: () => { throw new Error('SECRET_API_KEY_LEAK in config path /etc/passwd'); },
    now: () => FIXED_NOW,
  });
  const res1 = await call('router_plan', dThrowing);
  assert.notEqual(res1.isError, true);
  assert.match(res1.content[0]!.text, /Could not compute plan advice — check setup/);

  // Assert rendered text does not contain thrown key/path (Fix 3)
  assert.doesNotMatch(res1.content[0]!.text, /SECRET_API_KEY_LEAK|\/etc\/passwd/);

  // Assert structured output is strictly error-only (Fix 1)
  assert.deepEqual(res1.structuredContent, {
    error: true,
    message: 'could not compute plan advice — check setup',
  });

  // Case 2: analyzePlan itself throws due to malformed input (leaks nothing)
  const dAnalyzePlanThrowing = deps({
    allLanes: () => [],
    readLedger: () => [
      ...Array.from({ length: 10 }, (_, i) => ({
        event_type: 'task',
        schema_version: 2,
        id: `t-${i}`,
        seq: i,
        ts: new Date(FIXED_NOW).toISOString(),
        task_id: `t-${i}`,
        attempt: 0,
        category: 'feature',
        laneId: 'strong-lane',
        model: 'claude-opus-4-7',
        status: 'ok',
      } as any))
    ],
    loadPriceTable: () => null as any, // causes analyzePlan frontierModel lookup to throw TypeError
    now: () => FIXED_NOW,
  });
  const res2 = await call('router_plan', dAnalyzePlanThrowing);
  assert.notEqual(res2.isError, true);
  assert.match(res2.content[0]!.text, /Could not compute plan advice — check setup/);

  // Assert rendered text does not contain any details of the thrown error (Fix 3)
  assert.doesNotMatch(res2.content[0]!.text, /TypeError|frontier_model|Cannot read properties|null/i);

  // Assert structured output is strictly error-only (Fix 1)
  assert.deepEqual(res2.structuredContent, {
    error: true,
    message: 'could not compute plan advice — check setup',
  });
});

test('router_plan handles finite-sum overflow structured null and rendered unavailable', async () => {
  const strong = lane({ id: 'strong-lane', model: 'claude-opus-4-7', costBasis: 'metered', capability: { feature: 1.0 } });
  const d = deps({
    allLanes: () => [strong],
    readLedger: () => [
      ...Array.from({ length: 5 }, (_, i) => ({
        event_type: 'task',
        schema_version: 2,
        id: `t-${i}`,
        seq: i,
        ts: new Date(FIXED_NOW).toISOString(),
        task_id: `t-${i}`,
        attempt: 0,
        category: 'feature',
        laneId: 'strong-lane',
        model: 'claude-opus-4-7',
        status: 'ok',
        // Summing two finite spend values that exceed MAX_VALUE to cause Infinity overflow (FIX C)
        metered_spent: i >= 3 ? 1e308 : 0.5,
      } as any))
    ],
    now: () => FIXED_NOW,
  });
  const res = await call('router_plan', d);
  assert.notEqual(res.isError, true);
  assert.match(res.content[0]!.text, /metered spend: metered spend unavailable — data anomaly \(routed-share only\)/);

  const stats = (res.structuredContent as any).laneStats['strong-lane'];
  assert.equal(stats.meteredSpent, null);
  assert.equal(stats.meteredSpentUnavailable, true);
});

test('router_backtest tool execution, category-aware availability, and count-free output', async () => {
  const strong = lane({ id: 'strong-lane', model: 'claude-opus-4-7', costBasis: 'metered', capability: { feature: 1.0, bugfix: 1.0 } });
  const weakFeature = lane({ id: 'weak-lane-feature', model: 'claude-haiku', costBasis: 'local', capability: { feature: 0.7 } });
  const weakBugfix = lane({ id: 'weak-lane-bugfix', model: 'llama3', costBasis: 'local', capability: { bugfix: 0.7 } });

  const d = deps({
    allLanes: () => [strong, weakFeature, weakBugfix],
    readLedger: () => [
      {
        event_type: 'task',
        schema_version: 2,
        id: 't-1',
        seq: 1,
        ts: new Date(FIXED_NOW).toISOString(),
        task_id: 't-1',
        attempt: 0,
        category: 'feature',
        laneId: 'weak-lane-feature',
        model: 'claude-haiku',
        status: 'ok',
        actual_cost: 0,
        frontier_cost: 0.05,
        metered_spent: 0,
        frontier_avoided: 0.05,
        metered_avoided: 0.05,
        policy_verdict: 'allow',
      } as any,
      {
        event_type: 'task',
        schema_version: 2,
        id: 't-2',
        seq: 2,
        ts: new Date(FIXED_NOW).toISOString(),
        task_id: 't-2',
        attempt: 0,
        category: 'bugfix',
        laneId: 'weak-lane-bugfix',
        model: 'llama3',
        status: 'ok',
        actual_cost: 0,
        frontier_cost: 0.05,
        metered_spent: 0,
        frontier_avoided: 0.05,
        metered_avoided: 0.05,
        policy_verdict: 'allow',
      } as any
    ],
    now: () => FIXED_NOW,
    availableLaneIds: async (lanes) => {
      const ids = lanes.map((l) => l.id).sort();
      // Assert that the probed lanes are the union of feature-eligible and bugfix-eligible lanes
      assert.deepEqual(ids, ['strong-lane', 'weak-lane-bugfix', 'weak-lane-feature']);
      return ids;
    },
    tierFloor: 0.2,
  });

  const res = await call('router_backtest', d, { policyA: 'balanced', policyB: 'cheapest' });
  assert.notEqual(res.isError, true);

  const text = res.content[0]!.text;

  // Assert count-free text output
  assert.doesNotMatch(text, /total workload decisions/i);
  assert.doesNotMatch(text, /volume:/i);
  assert.doesNotMatch(text, /decision\(s\)/i);

  // Assert shares/percentages are rendered
  assert.match(text, /policy decision differences: 100\.0% of workload/i);
  assert.match(text, /share of workload: 50\.0%/i);
  assert.match(text, /net signal: neutral \/ insufficient/i);

  // Assert count-free structured content
  const struct = res.structuredContent as any;
  assert.ok(struct);
  assert.equal(struct.diffPercent, 100);
  assert.equal(struct.differences[0].workloadSharePercent, 50);
  assert.ok(!('totalDecisions' in struct));
  assert.ok(!('diffCount' in struct));
  assert.ok(!('volume' in struct.differences[0]));
});

test('router_backtest tool rejects invalid period with ToolInputError details', async () => {
  const d = deps({});
  const res = await call('router_backtest', d, { period: 'banana' });
  assert.equal(res.isError, true);
  const text = res.content[0]!.text;
  assert.match(text, /Invalid period format "banana"/i);
});

test('router_preview: task fingerprint is surfaced in text and structured output', async () => {
  const lanes = [
    lane({ id: 'metered-lane', model: 'gpt-5.5', costBasis: 'metered' }),
  ];
  const d = deps({
    candidateLanes: () => lanes,
  });

  const res = await call('router_preview', d, {
    category: 'bugfix',
    instruction: 'Write a python script to check credentials jwt token. Also run typecheck.',
  });

  assert.notEqual(res.isError, true);
  const text = res.content?.[0]?.text ?? '';

  // Assert presence of formatted fingerprint
  assert.match(text, /fingerprint: python \(0\.2\) · context: small · tools: medium · impl · security: yes · blast: narrow/);

  // Assert structured content contains the fingerprint
  const struct = res.structuredContent as any;
  assert.ok(struct.fingerprint);
  assert.equal(struct.fingerprint.language.lang, 'python');
  assert.equal(struct.fingerprint.language.confidence, 0.2);
  assert.equal(struct.fingerprint.contextSizeBand, 'small');
  assert.equal(struct.fingerprint.toolNeed, 'medium');
  assert.equal(struct.fingerprint.planVsImpl, 'impl');
  assert.equal(struct.fingerprint.securitySensitive, true);
  assert.equal(struct.fingerprint.blastRadius, 'narrow');
});

test('router_preview: task fingerprint is content-free under adversarial input', async () => {
  const lanes = [
    lane({ id: 'metered-lane', model: 'gpt-5.5', costBasis: 'metered' }),
  ];
  const d = deps({
    candidateLanes: () => lanes,
    readRepoFiles: (paths: readonly string[]) => {
      // Return empty so the tool doesn't print any skipped/attached files warning text
      return { attachments: [], skipped: [] };
    },
  });

  const instruction = 'AdversarialPromptSecretX99';
  const fileCount = 42;
  const files = Array.from({ length: fileCount }, (_, i) => `file${i}.js`);

  const res = await call('router_preview', d, {
    category: 'bugfix',
    instruction,
    files,
  });

  assert.notEqual(res.isError, true);
  const text = res.content?.[0]?.text ?? '';

  // Assert absence of any input substring, raw input length, or count in the rendered text
  assert.ok(!text.includes(instruction));
  assert.ok(!text.includes(String(instruction.length))); // input length
  assert.ok(!text.includes(String(fileCount))); // count of files

  // Recursively assert no leakage in structured content (keys AND values)
  const struct = res.structuredContent as any;
  assert.ok(struct.fingerprint);

  const ignoredWords = new Set([
    'ts', 'js', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'csharp', 'ruby', 'php', 'shell', 'sql', 'unknown',
    'small', 'medium', 'large', 'xlarge', 'low', 'high', 'plan', 'mixed', 'impl', 'narrow', 'moderate', 'wide',
    'true', 'false', 'yes', 'no'
  ]);
  const words = instruction.toLowerCase().split(/[^a-z0-9]+/i).filter(w => w.length >= 3 && !ignoredWords.has(w));
  const forbiddenNumbers = new Set([fileCount, instruction.length]);

  function walk(value: any) {
    if (typeof value === 'string') {
      const valLower = value.toLowerCase();
      for (const word of words) {
        assert.ok(!valLower.includes(word), `Structured value "${value}" contains input substring "${word}"`);
      }
    } else if (typeof value === 'number') {
      assert.ok(!forbiddenNumbers.has(value), `Structured value contains forbidden number ${value}`);
    } else if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) {
        const keyLower = k.toLowerCase();
        for (const word of words) {
          assert.ok(!keyLower.includes(word), `Structured key "${k}" contains input substring "${word}"`);
        }
        const keyNum = Number(k);
        if (Number.isFinite(keyNum)) {
          assert.ok(!forbiddenNumbers.has(keyNum), `Structured key "${k}" represents forbidden number ${keyNum}`);
        }
        walk(value[k]);
      }
    }
  }

  walk(struct.fingerprint);
});
