/**
 * C — local dashboard: pure data assembly (windows, quota axes, forecast
 * gating, recency) and the self-contained HTML renderer (sections, honest
 * labels, escaping, status-not-color-alone, no external requests).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SCHEMA_VERSION } from '../../core/src/index.ts';
import type { Lane, LedgerEvent, OutcomeEvent, TaskEvent } from '../../core/src/index.ts';

import { LEADERBOARD_CAVEAT, buildDashboardData, renderDashboardHtml } from '../src/dashboard.ts';

const NOW = Date.parse('2026-07-11T12:00:00.000Z');
const HOUR = 3_600_000;

let seq = 0;
function taskEvent(over: Partial<TaskEvent> = {}): TaskEvent {
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
    tokens_in: 100,
    tokens_out: 50,
    tokens_estimated: false,
    actual_cost: 0,
    frontier_cost: 1,
    metered_spent: 0,
    frontier_avoided: 1,
    metered_avoided: 1,
    policy_verdict: 'allow',
    ...over,
  };
}

function outcomeEvent(over: Partial<OutcomeEvent> = {}): OutcomeEvent {
  return {
    event_type: 'outcome',
    schema_version: SCHEMA_VERSION,
    id: `o-${seq}`,
    seq: seq++,
    ts: new Date(NOW - HOUR).toISOString(),
    subject_id: 't-0',
    subject_type: 'router_task',
    task_id: 'task-1',
    review_id: 'r-0',
    attempt: 0,
    category: 'bugfix',
    subject_lane_id: 'codex-cli',
    subject_provenance: 'openai',
    subject_model: 'gpt-5.5',
    subject_model_resolved: 'gpt-5.5',
    reviewer_lane_id: 'claude-native',
    reviewer_model: 'claude-opus-4-7',
    reviewer_trust_mode: 'full',
    reviewer_provenance: 'anthropic',
    verdict: 'pass',
    voter: 'reviewer_model',
    policy_verdict: 'allow',
    difficulty: 'easy',
    ...over,
  };
}

const lane = (over: Partial<Lane> & { id: string }): Lane => ({
  kind: 'cli', model: 'gpt-5.5', trust_mode: 'full', costBasis: 'subscription',
  provenance: 'openai', jurisdiction: 'US', ...over,
});

test('buildDashboardData: windows age correctly and use the canonical savings net', () => {
  const events: LedgerEvent[] = [
    taskEvent(), // 1h ago: frontier 1
    taskEvent({ ts: new Date(NOW - 3 * 24 * HOUR).toISOString() }), // 3d ago
    taskEvent({ ts: new Date(NOW - 20 * 24 * HOUR).toISOString(), metered_spent: 0.25 }), // 20d ago
  ];
  const d = buildDashboardData(events, [], NOW);
  const [h24, d7, life] = d.windows;
  assert.equal(h24!.offloads, 1);
  assert.equal(d7!.offloads, 2);
  assert.equal(life!.offloads, 3);
  assert.ok(Math.abs(life!.meteredAvoided - (3 - 0.25)) < 1e-9); // delivered frontier − ALL metered spend
  assert.equal(life!.tokens, 450);
});

test('buildDashboardData: quota axes appear only when configured; forecast only under pressure', () => {
  const lanes = [
    lane({ id: 'codex-cli', requests_per_window: 100 }), // 1/100 ⇒ ok ⇒ no forecast computed
    lane({ id: 'bare' }),
  ];
  const d = buildDashboardData([taskEvent()], lanes, NOW);
  const codex = d.lanes.find((l) => l.id === 'codex-cli')!;
  assert.deepEqual(codex.quota.map((a) => a.axis), ['5h window']);
  assert.equal(codex.quota[0]!.level, 'ok');
  assert.equal(codex.forecastEtaMs, undefined);
  assert.equal(codex.forecastLow, undefined);
  assert.deepEqual(d.lanes.find((l) => l.id === 'bare')!.quota, []);
});

test('buildDashboardData: recent rows are newest-first, capped, and exclude native breadcrumbs', () => {
  const events: LedgerEvent[] = [];
  for (let i = 0; i < 40; i++) events.push(taskEvent({ ts: new Date(NOW - (40 - i) * 60_000).toISOString() }));
  events.push(taskEvent({ status: 'native', native_reason: 'no_route' }));
  const d = buildDashboardData(events, [], NOW);
  assert.equal(d.recent.length, 30);
  assert.ok(Date.parse(d.recent[0]!.tsIso) > Date.parse(d.recent[29]!.tsIso)); // newest first
  assert.ok(d.recent.every((r) => r.status !== 'native'));
});

test('renderDashboardHtml: self-contained, honest, escaped, status never color-alone', () => {
  const events: LedgerEvent[] = [taskEvent({ laneId: '<lane&"x">', model: '<m>' }), outcomeEvent()];
  const lanes = [lane({ id: '<lane&"x">', model: '<m>', requests_per_window: 1 })];
  const html = renderDashboardHtml(buildDashboardData(events, lanes, NOW));
  // Self-contained: no external fetches of any kind.
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<script src|<link rel/);
  // Honesty labels.
  assert.match(html, /routed share/);
  assert.match(html, /est\. metered avoided/);
  assert.ok(html.includes(LEADERBOARD_CAVEAT));
  // Escaping: the raw injection strings never appear unescaped.
  assert.doesNotMatch(html, /<lane&"x">/);
  assert.match(html, /&lt;lane&amp;&quot;x&quot;&gt;/);
  // Status meters carry a TEXT level label, never color alone.
  assert.match(html, /🛑 CRITICAL/); // 1/1 used ⇒ critical
  // Dark mode is selected, not an automatic flip.
  assert.match(html, /prefers-color-scheme: dark/);
  // Leaderboard N column present (thin rows must be visibly thin).
  assert.match(html, /<th>N<\/th>/);
});

test('renderDashboardHtml: empty ledger still renders every section', () => {
  const html = renderDashboardHtml(buildDashboardData([], [lane({ id: 'codex-cli' })], NOW));
  for (const section of ['Savings', 'Quota', 'Leaderboard', 'Review outcomes', 'Recent offloads']) {
    assert.ok(html.includes(section), `missing section ${section}`);
  }
  assert.match(html, /no quota configured/);
});

test('buildDashboardData: pressure enables the forecast — moderate renders a time, low a timeless notice', () => {
  // Rising fixture (B plan §1.4): 100s window, limit 20, 6 then 12 obs ⇒
  // critical pressure + a MODERATE projection (ratio 2, span 91%).
  const W = 100_000;
  const mkAt = (agoList: number[], laneId: string): TaskEvent[] =>
    agoList.map((ago) => taskEvent({ ts: new Date(NOW - ago).toISOString(), laneId }));
  const rising = [
    ...mkAt(Array.from({ length: 6 }, (_, i) => 95_000 - i * 5_000), 'codex-cli'),
    ...mkAt(Array.from({ length: 12 }, (_, i) => 48_000 - i * 4_000), 'codex-cli'),
  ];
  const moderate = buildDashboardData(rising, [lane({ id: 'codex-cli', requests_per_window: 20, window_ms: W })], NOW);
  const m = moderate.lanes[0]!;
  assert.equal(m.quota[0]!.level, 'critical'); // 18/20
  assert.ok(m.forecastEtaMs !== undefined && m.forecastLow === undefined);
  const htmlM = renderDashboardHtml(moderate);
  assert.match(htmlM, /est\. now to cap at routed pace/); // eta ≈44s ⇒ honest 'now'
  // LOW confidence (ratio 2.4: halves 5 vs 12) ⇒ timeless notice, never a time.
  const low = [
    ...mkAt(Array.from({ length: 5 }, (_, i) => 95_000 - i * 10_000, ), 'codex-cli'),
    ...mkAt(Array.from({ length: 12 }, (_, i) => 48_000 - i * 4_000), 'codex-cli'),
  ];
  const lowData = buildDashboardData(low, [lane({ id: 'codex-cli', requests_per_window: 18, window_ms: W })], NOW);
  const l = lowData.lanes[0]!;
  assert.equal(l.forecastEtaMs, undefined);
  assert.equal(l.forecastLow, true);
  const htmlL = renderDashboardHtml(lowData);
  assert.match(htmlL, /approaching cap \(routed\)/);
  assert.doesNotMatch(htmlL, /to cap at routed pace/);
});
