/**
 * B1 — quota-brain state: config validation (registry), weighted observation
 * extraction, per-axis state (window / weekly requests / weekly tokens),
 * min-across-axes headroom, and the omit-when-unconfigured invariant.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SCHEMA_VERSION } from '../src/ledger.ts';
import type { LedgerEvent, TaskEvent } from '../src/ledger.ts';
import { laneObservations, laneQuotaState, quotaHeadroomMap, WEEK_MS } from '../src/quota.ts';
import { parseLaneConfig } from '../src/registry.ts';
import type { Lane } from '../src/types.ts';
import { FIVE_HOUR_MS } from '../src/window-quota.ts';

const NOW = Date.parse('2026-07-11T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let seq = 0;
function taskEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    event_type: 'task',
    schema_version: SCHEMA_VERSION,
    id: `t-${seq}`,
    seq: seq++,
    ts: new Date(NOW - HOUR).toISOString(),
    task_id: `task-${seq}`,
    attempt: 0,
    category: 'bugfix',
    laneId: 'codex-cli',
    model: 'gpt-5.5',
    trust_mode: 'full',
    provenance: 'openai',
    status: 'ok',
    tokens_in: 1000,
    tokens_out: 500,
    tokens_estimated: false,
    actual_cost: 0,
    frontier_cost: 1,
    metered_spent: 0,
    frontier_avoided: 1,
    metered_avoided: 1,
    policy_verdict: 'allow',
    ...overrides,
  };
}

const lane = (over: Partial<Lane> & { id: string }): Lane => ({
  kind: 'cli', model: 'm', trust_mode: 'full', costBasis: 'subscription',
  provenance: 'openai', jurisdiction: 'US', ...over,
});

// --- registry validation ------------------------------------------------------

test('registry: quota fields accept positive finite numbers and reject the rest', () => {
  const base = {
    id: 'x', kind: 'cli', model: 'm', command: 'node', trust_mode: 'full',
    costBasis: 'subscription', provenance: 'openai', jurisdiction: 'US',
  };
  // parseLaneConfig takes YAML text; JSON is a YAML subset, so stringify works.
  const good = parseLaneConfig(
    JSON.stringify({ lanes: [{ ...base, window_ms: 3_600_000, requests_per_week: 500, tokens_per_week: 1_000_000 }] }),
  );
  const l = good.lanes[0]!;
  assert.equal(l.window_ms, 3_600_000);
  assert.equal(l.requests_per_week, 500);
  assert.equal(l.tokens_per_week, 1_000_000);
  for (const bad of [{ window_ms: 0 }, { requests_per_week: -1 }, { tokens_per_week: 'many' }, { window_ms: -5 }]) {
    assert.throws(() => parseLaneConfig(JSON.stringify({ lanes: [{ ...base, ...bad }] })), /positive finite number/);
  }
});

// --- observations ---------------------------------------------------------------

test('laneObservations: routed legs only, weighted per axis, invalid timestamps dropped', () => {
  const events: LedgerEvent[] = [
    taskEvent(),
    taskEvent({ status: 'native', native_reason: 'no_route' }), // not routed
    taskEvent({ laneId: 'other' }), // other lane
    taskEvent({ ts: 'not-a-date' }), // invalid ts
    taskEvent({ status: 'failed' }), // failed leg still consumed quota
  ];
  const reqs = laneObservations(events, 'codex-cli', false);
  assert.equal(reqs.length, 2);
  assert.ok(reqs.every((o) => o.amount === 1));
  const toks = laneObservations(events, 'codex-cli', true);
  assert.ok(toks.every((o) => o.amount === 1500));
});

// --- state ----------------------------------------------------------------------

test('laneQuotaState: no quota config ⇒ headroom 1, no axes (zero-change invariant)', () => {
  const s = laneQuotaState([taskEvent()], lane({ id: 'codex-cli' }), NOW);
  assert.deepEqual(s, { headroom: 1 });
});

test('laneQuotaState: window axis counts inside window_ms override; old events age out', () => {
  const l = lane({ id: 'codex-cli', requests_per_window: 10, window_ms: 2 * HOUR });
  const events = [
    taskEvent(), // 1h ago — inside the 2h window
    taskEvent({ ts: new Date(NOW - 3 * HOUR).toISOString() }), // outside 2h
  ];
  const s = laneQuotaState(events, l, NOW);
  assert.equal(s.window?.count, 1);
  assert.equal(s.window?.limit, 10);
  assert.equal(s.window?.level, 'ok');
  // Default window (5h) would count both.
  const s5 = laneQuotaState(events, lane({ id: 'codex-cli', requests_per_window: 10 }), NOW);
  assert.equal(s5.window?.count, 2);
});

test('laneQuotaState: weekly axes count 7d trailing; tokens weighted; levels at 0.7/0.9', () => {
  const l = lane({ id: 'codex-cli', requests_per_week: 10, tokens_per_week: 15_000 });
  const events: LedgerEvent[] = [];
  for (let i = 0; i < 7; i++) events.push(taskEvent({ ts: new Date(NOW - (i + 1) * 12 * HOUR).toISOString() }));
  events.push(taskEvent({ ts: new Date(NOW - WEEK_MS - HOUR).toISOString() })); // aged out
  const s = laneQuotaState(events, l, NOW);
  assert.equal(s.weekRequests?.count, 7);
  assert.equal(s.weekRequests?.level, 'warn'); // 7/10 = 0.7
  assert.equal(s.weekTokens?.count, 7 * 1500);
  assert.equal(s.weekTokens?.level, 'warn'); // 10500/15000 = 0.7 ⇒ warn threshold exactly
});

test('laneQuotaState: headroom is the MIN across configured axes and floors at 0', () => {
  const l = lane({ id: 'codex-cli', requests_per_window: 100, tokens_per_week: 1_000 });
  const events = [taskEvent(), taskEvent(), taskEvent()]; // 3 reqs, 4500 tokens (over the 1k cap)
  const s = laneQuotaState(events, l, NOW);
  assert.equal(s.window?.count, 3);
  assert.ok(Math.abs(s.headroom - 0) < 1e-9); // token axis exhausted ⇒ min = 0
});

// --- headroom map ----------------------------------------------------------------

test('quotaHeadroomMap: only quota-configured lanes appear (empty map when none)', () => {
  const events = [taskEvent()];
  const none = quotaHeadroomMap(events, [lane({ id: 'codex-cli' }), lane({ id: 'b' })], NOW);
  assert.equal(Object.keys(none).length, 0);
  const some = quotaHeadroomMap(events, [lane({ id: 'codex-cli', requests_per_window: 2 }), lane({ id: 'b' })], NOW);
  assert.deepEqual(Object.keys(some), ['codex-cli']);
  assert.ok(Math.abs(some['codex-cli']! - 0.5) < 1e-9); // 1/2 used
});
