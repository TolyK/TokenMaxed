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
  filterEventsSince,
  routeDecide,
  summarize,
  tokenStats,
  classifyTask,
  MIN_CLASSIFY_CONFIDENCE,
  CLASSIFY_FALLBACK_CATEGORY,
  SCHEMA_VERSION,
  serializeEvent,
} from '../../core/src/index.ts';
import type { Lane, LedgerEvent, Policy, RouteDecision } from '../../core/src/index.ts';

import { createTools, dispatch, resolveCategory } from '../src/tools.ts';
import type { CorePort, DelegateOutcome, DelegateRequest, ReviewOutcome, SetupReport, ToolDeps } from '../src/tools.ts';

// --- harness -------------------------------------------------------------------

const CORE: CorePort = {
  filterEventsSince,
  summarize,
  tokenStats,
  routeDecide,
  eligibleLanes,
  evaluate,
  taskCategories: TASK_CATEGORIES,
  classifyTask,
  MIN_CLASSIFY_CONFIDENCE,
  CLASSIFY_FALLBACK_CATEGORY,
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
      readerEgress: false,
      tiered: false,
      yolo: false,
      lanes: [],
      laneReview: 'current',
    }),
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
      'router_delegate',
      'router_preview',
      'router_review',
      'router_savings',
      'router_set_enabled',
      'router_set_prefer',
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
  assert.match(r.content[0]!.text, /already present/);
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
