/**
 * A3 — statusline quota gauge: pure data builder + formatter, the env I/O
 * wrapper over temp files, kill-switch silence, and fail-open behavior.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SCHEMA_VERSION, serializeEvent } from '../../core/src/index.ts';
import type { Lane, LedgerEvent, TaskEvent } from '../../core/src/index.ts';

import { buildStatuslineData, formatStatusline, statuslineFromEnv } from '../src/statusline.ts';
import { receiptFromEvents } from '../src/server.ts';

const NOW = Date.parse('2026-07-11T12:00:00.000Z');

let seq = 0;
function taskEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    event_type: 'task',
    schema_version: SCHEMA_VERSION,
    id: `t-${seq}`,
    seq: seq++,
    ts: new Date(NOW - 60_000).toISOString(),
    task_id: `task-${seq}`,
    attempt: 0,
    category: 'bugfix',
    laneId: 'codex-cli',
    model: 'gpt-5.5',
    trust_mode: 'full',
    provenance: 'openai',
    status: 'ok',
    tokens_in: 1000,
    tokens_out: 200,
    tokens_estimated: false,
    actual_cost: 0,
    frontier_cost: 1,
    metered_spent: 0,
    frontier_avoided: 1,
    metered_avoided: 0.5,
    policy_verdict: 'allow',
    ...overrides,
  };
}

const lane = (over: Partial<Lane> & { id: string }): Lane => ({
  kind: 'cli', model: 'm', trust_mode: 'full', costBasis: 'subscription',
  provenance: 'openai', jurisdiction: 'US', ...over,
});

test('buildStatuslineData: empty ledger ⇒ empty gauge', () => {
  const d = buildStatuslineData([], [], NOW);
  assert.equal(d.empty, true);
  assert.equal(formatStatusline(d), 'tmax · no routed tasks yet');
});

test('buildStatuslineData: 7d avoided matches summarize() over recent events; old events age out', () => {
  // summarize() recomputes savings from frontier_cost/metered_spent totals, so
  // the gauge shows exactly what /tokenmaxed:savings shows for the same window.
  const events: LedgerEvent[] = [
    taskEvent({ frontier_cost: 1, metered_spent: 0 }),
    taskEvent({ ts: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString(), frontier_cost: 9 }),
  ];
  const d = buildStatuslineData(events, [], NOW);
  assert.equal(d.empty, false);
  assert.ok(Math.abs(d.avoided7dUsd - 1) < 1e-9, `avoided7d ${d.avoided7dUsd} ≈ 1`);
  assert.match(formatStatusline(d), /est\. \$1\.00 metered avoided \(7d\)/);
});

test('buildStatuslineData: tightest 5h window wins; native breadcrumbs are not requests', () => {
  const lanes = [
    lane({ id: 'codex-cli', requests_per_window: 10 }),
    lane({ id: 'claude-cli', requests_per_window: 100 }),
  ];
  const events: LedgerEvent[] = [];
  for (let i = 0; i < 8; i++) events.push(taskEvent({ laneId: 'codex-cli' })); // 8/10 ⇒ 0.8 ⇒ warn
  for (let i = 0; i < 20; i++) events.push(taskEvent({ laneId: 'claude-cli' })); // 20/100 ⇒ 0.2 ⇒ ok
  events.push(taskEvent({ laneId: 'codex-cli', status: 'native', native_reason: 'no_route' })); // not counted
  const d = buildStatuslineData(events, lanes, NOW);
  assert.deepEqual(d.window, { laneId: 'codex-cli', count: 8, limit: 10, level: 'warn' });
  assert.match(formatStatusline(d), /5h codex-cli 8\/10 routed ⚠/);
});

test('formatStatusline: critical marker at >=90% used; no marker when ok', () => {
  assert.match(
    formatStatusline({ avoided7dUsd: 1, window: { laneId: 'x', count: 9, limit: 10, level: 'critical' }, empty: false }),
    /5h x 9\/10 routed 🛑/,
  );
  assert.doesNotMatch(
    formatStatusline({ avoided7dUsd: 1, window: { laneId: 'x', count: 1, limit: 10, level: 'ok' }, empty: false }),
    /⚠|🛑/,
  );
});

test('statuslineFromEnv: reads temp lanes + ledger; missing lanes file ⇒ still renders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-statusline-'));
  try {
    const lanesYaml = `lanes:
  - id: codex-cli
    kind: cli
    model: gpt-5.5
    command: node
    trust_mode: full
    costBasis: subscription
    provenance: openai
    jurisdiction: US
    requests_per_window: 10
`;
    writeFileSync(join(dir, 'lanes.yaml'), lanesYaml, 'utf8');
    const events = [taskEvent(), taskEvent(), taskEvent()];
    writeFileSync(join(dir, 'ledger.jsonl'), events.map((e) => serializeEvent(e)).join('\n') + '\n', 'utf8');
    const line = statuslineFromEnv(
      { TOKENMAXED_LANES: join(dir, 'lanes.yaml'), TOKENMAXED_LEDGER: join(dir, 'ledger.jsonl') },
      NOW,
    );
    assert.match(line, /^tmax · est\. \$3\.00 metered avoided \(7d\) · 5h codex-cli 3\/10 routed$/);
    // Missing lanes file ⇒ no window segment, still a valid line (fail-open shape).
    const noLanes = statuslineFromEnv(
      { TOKENMAXED_LANES: join(dir, 'nope.yaml'), TOKENMAXED_LEDGER: join(dir, 'ledger.jsonl') },
      NOW,
    );
    assert.match(noLanes, /^tmax · est\. \$3\.00 metered avoided \(7d\)$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- receiptFromEvents (server-side aggregation, same file for A3 cohesion) -------

test('receiptFromEvents mirrors summarize(): delivered-only baseline minus ALL legs\' metered spend', () => {
  // Superseded leg: spend counts, baseline doesn't. Delivered leg: baseline counts.
  const r = receiptFromEvents([
    taskEvent({ tokens_in: 1000, tokens_out: 200, frontier_cost: 1, metered_spent: 0.5, superseded: true }),
    taskEvent({ tokens_in: 2000, tokens_out: 400, tokens_estimated: true, frontier_cost: 1, metered_spent: 0.03 }),
  ]);
  assert.deepEqual(r, {
    tokensIn: 3000,
    tokensOut: 600,
    tokensEstimated: true,
    spentUsd: 0.53,
    meteredAvoidedUsd: 1 - 0.53, // canonical: delivered frontier (1) − all metered spend (0.53)
    legs: 2,
  });
});

test('receiptFromEvents: a failed leg claims NO baseline — avoided goes negative when it cost money', () => {
  const r = receiptFromEvents([taskEvent({ status: 'failed', frontier_cost: 1, metered_spent: 0.02 })]);
  assert.equal(r?.spentUsd, 0.02);
  assert.ok(Math.abs((r?.meteredAvoidedUsd ?? 0) - -0.02) < 1e-9, `avoided ${r?.meteredAvoidedUsd} ≈ -0.02`);
});

test('receiptFromEvents: native breadcrumbs are not legs; none ⇒ undefined', () => {
  assert.equal(receiptFromEvents([]), undefined);
  assert.equal(receiptFromEvents([taskEvent({ status: 'native', native_reason: 'no_route' })]), undefined);
  const r = receiptFromEvents([
    taskEvent({ status: 'native', native_reason: 'no_route' }),
    taskEvent({ tokens_in: 10, tokens_out: 5 }),
  ]);
  assert.equal(r?.legs, 1);
  assert.equal(r?.tokensIn, 10);
});

test('buildStatuslineData: a native-only ledger still renders the empty state', () => {
  const d = buildStatuslineData([taskEvent({ status: 'native', native_reason: 'no_route' })], [], NOW);
  assert.equal(d.empty, true);
  assert.equal(formatStatusline(d), 'tmax · no routed tasks yet');
});


// --- B3: statusline depletion eta ---------------------------------------------

test('statusline: warn/critical + moderate evidence appends the routed-only eta; ok level never does', () => {
  // Rising fixture (plan §1.4 math): 6 obs then 12 obs across a 100s window,
  // limit 20 ⇒ occupancy 18 (critical) and a moderate-confidence eta ≈ 44.4s.
  const l = lane({ id: 'codex-cli', requests_per_window: 20, window_ms: 100_000 });
  const events: LedgerEvent[] = [];
  const mk = (agoList: number[]) => {
    for (const ago of agoList) events.push(taskEvent({ ts: new Date(NOW - ago).toISOString(), task_id: `s-${seq}` }));
  };
  const first = Array.from({ length: 6 }, (_, i) => 95_000 - i * 5_000);
  const second = Array.from({ length: 12 }, (_, i) => 48_000 - i * 4_000);
  mk(first);
  mk(second);
  const d = buildStatuslineData(events, [l], NOW);
  assert.equal(d.window?.level, 'critical'); // 18/20
  assert.ok(d.window?.etaMs !== undefined);
  assert.match(formatStatusline(d), /2m codex-cli 18\/20 routed 🛑 → est\. now \(routed-only\)$/);
});
