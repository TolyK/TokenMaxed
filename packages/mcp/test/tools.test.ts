/**
 * A-1 tests — the read-only MCP tool handlers, exercised with fake injected
 * deps and the REAL core operations. Core is imported via its source path
 * (`../../core/src/index.ts`), not the package name, so `node --test` type-strips
 * it with no prior build — preserving the documented no-build workflow.
 *
 * Covers savings/tokens/preview happy paths, the empty ledger, period filtering,
 * percentage scaling, input validation, native-degrade preview, and dispatch.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TASK_CATEGORIES,
  evaluate,
  filterEventsSince,
  routeDecide,
  summarize,
  tokenStats,
} from '../../core/src/index.ts';
import type { Lane, LedgerEvent, Policy } from '../../core/src/index.ts';

import { createTools, dispatch } from '../src/tools.ts';
import type { CorePort, ToolDeps } from '../src/tools.ts';

// --- harness -------------------------------------------------------------------

const CORE: CorePort = { filterEventsSince, summarize, tokenStats, routeDecide, evaluate, taskCategories: TASK_CATEGORIES };
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
    loadPolicy: (): Policy => ({}),
    getEnabled: () => true,
    setEnabled: () => {},
    now: () => FIXED_NOW,
    ...over,
  };
}

/** Invoke a tool through dispatch (also exercising name resolution). */
function call(name: string, d: ToolDeps, args: Record<string, unknown> = {}) {
  return dispatch(TOOLS, d, name, args);
}

// --- registry + dispatch -------------------------------------------------------

test('builds the expected tool set with object input schemas', () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name).sort(),
    ['router_preview', 'router_savings', 'router_set_enabled', 'router_status', 'router_tokens'],
  );
  for (const t of TOOLS) {
    assert.equal((t.inputSchema as { type: string }).type, 'object');
    assert.ok(t.description.length > 0);
  }
});

test('dispatch returns an isError result for an unknown tool', () => {
  const r = dispatch(TOOLS, deps(), 'router_nope', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /Unknown tool/);
});

test('dispatch rejects unknown argument keys (additionalProperties:false)', () => {
  const r1 = dispatch(TOOLS, deps(), 'router_savings', { peroid: '7d' }); // typo
  assert.equal(r1.isError, true);
  assert.match(r1.content[0]!.text, /Unknown argument\(s\): peroid/);

  const r2 = dispatch(TOOLS, deps(), 'router_preview', { category: 'bugfix', gateReady: true }); // wrong key
  assert.equal(r2.isError, true);
  assert.match(r2.content[0]!.text, /Unknown argument\(s\): gateReady/);
});

// --- router_savings ------------------------------------------------------------

test('savings on an empty ledger reports nothing recorded, not an error', () => {
  const r = call('router_savings', deps());
  assert.notEqual(r.isError, true);
  assert.match(r.content[0]!.text, /No tasks recorded/);
  assert.equal((r.structuredContent!.summary as { events: number }).events, 0);
});

test('savings aggregates avoided spend and tokens from the ledger', () => {
  const events = [
    taskEvent({ ts: '2026-06-02T11:00:00.000Z', laneId: 'codex', model: 'gpt' }),
    taskEvent({ ts: '2026-06-02T11:30:00.000Z', laneId: 'codex', model: 'gpt', seq: 1 }),
  ];
  const r = call('router_savings', deps({ readLedger: () => events }));
  assert.notEqual(r.isError, true);
  const summary = r.structuredContent!.summary as { events: number; savings: { frontier_avoided: number } };
  assert.equal(summary.events, 2);
  assert.ok(Math.abs(summary.savings.frontier_avoided - 0.018) < 1e-9);
  assert.match(r.content[0]!.text, /frontier-equivalent avoided/);
});

test('savings renders percentages already in percent units (no 100x double-scale)', () => {
  // frontier_avoided 0.009 / frontier_cost 0.01 ⇒ 90.0%, never 9000.0%.
  const events = [taskEvent({ ts: '2026-06-02T11:00:00.000Z', laneId: 'codex', model: 'gpt' })];
  const r = call('router_savings', deps({ readLedger: () => events }));
  assert.match(r.content[0]!.text, /\(90\.0%\)/);
  assert.doesNotMatch(r.content[0]!.text, /9000/);
});

test('savings honours the period window', () => {
  const events = [
    taskEvent({ ts: '2026-05-01T00:00:00.000Z', laneId: 'codex', model: 'gpt' }), // old, excluded by 7d
    taskEvent({ ts: '2026-06-02T11:00:00.000Z', laneId: 'codex', model: 'gpt', seq: 1 }),
  ];
  const r = call('router_savings', deps({ readLedger: () => events }), { period: '7d' });
  assert.equal((r.structuredContent!.summary as { events: number }).events, 1);
});

test('savings rejects a malformed period', () => {
  const r = call('router_savings', deps(), { period: 'banana' });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /Invalid period/);
});

// --- router_tokens -------------------------------------------------------------

test('tokens groups by model by default and by lane on request', () => {
  const events = [
    taskEvent({ ts: '2026-06-02T11:00:00.000Z', laneId: 'codex', model: 'gpt' }),
    taskEvent({ ts: '2026-06-02T11:30:00.000Z', laneId: 'ollama', model: 'llama', seq: 1 }),
  ];
  const byModel = call('router_tokens', deps({ readLedger: () => events }));
  assert.equal(byModel.structuredContent!.by as string, 'model');
  assert.match(byModel.content[0]!.text, /by model:/);

  const byLane = call('router_tokens', deps({ readLedger: () => events }), { by: 'lane' });
  assert.equal(byLane.structuredContent!.by as string, 'lane');
  assert.match(byLane.content[0]!.text, /codex:/);
});

test('tokens rejects an unknown grouping', () => {
  const r = call('router_tokens', deps(), { by: 'galaxy' });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /must be one of/);
});

// --- router_status / router_set_enabled (A-4 toggle) ---------------------------

test('status reports the current enabled state', () => {
  const on = call('router_status', deps({ getEnabled: () => true }));
  assert.equal(on.structuredContent!.enabled as boolean, true);
  assert.match(on.content[0]!.text, /ENABLED/);

  const off = call('router_status', deps({ getEnabled: () => false }));
  assert.equal(off.structuredContent!.enabled as boolean, false);
  assert.match(off.content[0]!.text, /DISABLED/);
});

test('set_enabled persists the requested state', () => {
  const calls: boolean[] = [];
  const r = call('router_set_enabled', deps({ setEnabled: (e) => calls.push(e) }), { enabled: false });
  assert.notEqual(r.isError, true);
  assert.deepEqual(calls, [false]);
  assert.match(r.content[0]!.text, /DISABLED/);
});

test('set_enabled requires a boolean enabled and rejects other types', () => {
  const missing = call('router_set_enabled', deps(), {});
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text, /required/);

  const wrong = call('router_set_enabled', deps(), { enabled: 'yes' });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0]!.text, /must be a boolean/);
});

// --- router_preview ------------------------------------------------------------

test('preview routes a category to a lane without executing', () => {
  const lanes = [lane({ id: 'claude-native', native: true })];
  const r = call('router_preview', deps({ candidateLanes: () => lanes }), { category: 'bugfix' });
  assert.notEqual(r.isError, true);
  assert.equal(r.structuredContent!.native as boolean, false);
  assert.match(r.content[0]!.text, /category "bugfix" → lane "claude-native"/);
  assert.match(r.content[0]!.text, /policy verdict:/);
});

test('preview defaults gate_ready to false (matching core), degrading worker-only to native', () => {
  // No gate_ready ⇒ default false; a worker-only config has nothing selectable
  // pre-gate, so the preview must report native — never claim the worker lane.
  const lanes = [lane({ id: 'worker', kind: 'api', trust_mode: 'worker', provenance: 'deepseek', jurisdiction: 'CN' })];
  const r = call('router_preview', deps({ candidateLanes: () => lanes }), { category: 'bugfix' });
  assert.notEqual(r.isError, true);
  assert.equal(r.structuredContent!.native as boolean, true);
  assert.match(r.content[0]!.text, /native/);
});

test('preview requires a known category', () => {
  const r1 = call('router_preview', deps(), {});
  assert.equal(r1.isError, true);
  const r2 = call('router_preview', deps(), { category: 'nonsense' });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0]!.text, /must be one of/);
});

test('preview rejects a non-boolean gate_ready instead of silently defaulting', () => {
  const r = call('router_preview', deps(), { category: 'bugfix', gate_ready: 'true' });
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /must be a boolean/);
});

test('preview passes repo_class/sensitivity into the policy context', () => {
  const lanes = [lane({ id: 'claude-native', native: true })];
  const r = call('router_preview', deps({ candidateLanes: () => lanes }), {
    category: 'bugfix',
    repo_class: 'private',
    sensitivity: 'sensitive',
  });
  assert.deepEqual(r.structuredContent!.policyContext, { repo_class: 'private', sensitivity: 'sensitive' });
});
