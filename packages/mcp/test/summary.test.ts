/**
 * Tests for the pure session-summary builder + renderer. Uses the REAL core
 * aggregate functions and selectManagerLane (injected), over fixture ledgers.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterEventsSince, summarize, tokenStats } from '../../core/src/index.ts';
import type { LedgerEvent, Lane } from '../../core/src/index.ts';

import { selectManagerLane } from '../src/manager-select.ts';
import { buildSummaryData, clampBanner, formatSummaryBanner } from '../src/summary.ts';

const NOW = Date.parse('2026-06-04T12:00:00.000Z');
const core = { summarize, tokenStats, filterEventsSince };

function taskEvent(over: Partial<LedgerEvent> & { ts: string; laneId: string }): LedgerEvent {
  return {
    event_type: 'task',
    schema_version: 1,
    id: over.id ?? `e-${over.ts}-${over.laneId}`,
    seq: over.seq ?? 0,
    task_id: over.task_id ?? `t-${over.ts}`,
    attempt: 0,
    category: 'bugfix',
    model: 'm',
    trust_mode: 'full',
    provenance: 'anthropic',
    status: 'ok',
    tokens_in: 100,
    tokens_out: 50,
    tokens_estimated: false,
    actual_cost: 0,
    frontier_cost: 0.1,
    metered_spent: 0,
    frontier_avoided: 0.1,
    metered_avoided: 0,
    policy_verdict: 'allow',
    ...over,
  } as LedgerEvent;
}

const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const events: LedgerEvent[] = [
  taskEvent({ ts: hoursAgo(1), laneId: 'codex-cli', tokens_in: 100, tokens_out: 50, metered_spent: 0, metered_avoided: 0.01 }),
  taskEvent({ ts: hoursAgo(72), laneId: 'minimax-api', tokens_in: 200, tokens_out: 100, metered_spent: 0.02, metered_avoided: 0 }),
  taskEvent({ ts: hoursAgo(240), laneId: 'ollama-llama3', tokens_in: 1000, tokens_out: 0, metered_spent: 0, metered_avoided: 0.05 }),
];

const lane = (over: Partial<Lane> & { id: string }): Lane => ({
  kind: 'cli', model: 'm', trust_mode: 'full', costBasis: 'subscription',
  provenance: 'anthropic', jurisdiction: 'US', ...over,
});
const lanes: Lane[] = [
  lane({ id: 'codex-cli', provenance: 'openai', command: 'codex', manager_allowed: true, roles: ['manager'] }),
  lane({ id: 'claude-haiku', command: 'claude', manager_allowed: true, roles: ['manager'] }),
  lane({ id: 'minimax-api', kind: 'api', model: 'minimax-m2', trust_mode: 'worker', provenance: 'minimax', endpoint: 'https://x', authHandle: 'MINIMAX' }),
  lane({ id: 'ollama-llama3', kind: 'local', costBasis: 'local', provenance: 'meta' }),
];

function build(over: Partial<Parameters<typeof buildSummaryData>[0]> = {}) {
  return buildSummaryData({
    events,
    lanes,
    policy: {},
    availableLaneIds: ['codex-cli', 'claude-haiku'], // ollama offline, minimax no key
    gateReady: true,
    enabled: true,
    now: NOW,
    core,
    selectManager: selectManagerLane,
    staleness: [],
    ...over,
  });
}

test('windows aggregate tokens, metered-avoided, and offload counts correctly', () => {
  const d = build();
  const [h24, d7, life] = d.windows;
  assert.deepEqual([h24!.label, d7!.label, life!.label], ['24h', '7d', 'lifetime']);
  assert.equal(h24!.offloads, 1); // only the 1h-ago event
  assert.equal(d7!.offloads, 2); // 1h + 72h
  assert.equal(life!.offloads, 3); // all
  assert.equal(h24!.tokens, 150);
  assert.equal(life!.tokens, 1450);
  // Canonical savings: metered_avoided = frontier_cost(ok) − metered_spent.
  // lifetime: 3×0.1 frontier − 0.02 metered = 0.28; 24h: 0.1 − 0 = 0.10.
  assert.equal(Number(life!.meteredAvoided.toFixed(2)), 0.28);
  assert.equal(Number(h24!.meteredAvoided.toFixed(2)), 0.10);
});

test('zeroMeteredShare is token-weighted over $0-metered task events', () => {
  // $0-metered tokens = 150 (codex) + 1000 (ollama) = 1150; all = 1450 → ~0.793
  const d = build();
  assert.ok(Math.abs(d.zeroMeteredShare - 1150 / 1450) < 1e-9);
});

test('active reviewer comes from selectManagerLane (first eligible + available)', () => {
  const d = build();
  assert.equal(d.activeReviewerId, 'codex-cli');
  const codexLane = d.lanes.find((l) => l.id === 'codex-cli')!;
  assert.equal(codexLane.isActiveReviewer, true);
});

test('an unavailable lane is flagged offline', () => {
  const d = build();
  assert.equal(d.lanes.find((l) => l.id === 'ollama-llama3')!.available, false);
  assert.equal(d.lanes.find((l) => l.id === 'codex-cli')!.available, true);
});

test('empty ledger reports empty without throwing', () => {
  const d = build({ events: [] });
  assert.equal(d.empty, true);
  assert.equal(d.zeroMeteredShare, 1); // no tokens ⇒ default 100%
});

test('banner headline is finance-grade (metered $), never the frontier hypothetical', () => {
  const banner = formatSummaryBanner(build());
  assert.match(banner, /Saved \$\d/); // metered $ headline present
  assert.match(banner, /metered API spend/);
  assert.match(banner, /\$0 metered/); // the honest proxy line
  // HONESTY GUARD: the all-frontier figure must never surface in the banner.
  assert.doesNotMatch(banner, /frontier/i);
  assert.doesNotMatch(banner, /trees|coffee/i); // no unlabeled relatable units
});

test('banner flags a stale lane from the (cache-derived) staleness input', () => {
  const banner = formatSummaryBanner(build({
    staleness: [{ laneId: 'minimax-api', newest: 'minimax-m3', newestPriced: true }],
  }));
  assert.match(banner, /minimax-api \(worker\).*⚠ stale/); // marked in the Lanes line (after any offline flag)
  assert.match(banner, /minimax-api on minimax-m2 — newer available: minimax-m3/); // spelled out
});

test('banner spells out a pricing-gap (newer model not priced)', () => {
  const banner = formatSummaryBanner(build({
    staleness: [{ laneId: 'minimax-api', newest: 'minimax-m9', newestPriced: false }],
  }));
  assert.match(banner, /newer minimax-m9 exists but isn't priced yet/);
});

test('banner hints to run setup when lanes changed / first-review (read-only nudge)', () => {
  assert.match(formatSummaryBanner(build({ laneReview: 'changed' })), /lanes changed since you last reviewed them — run \/tokenmaxed:setup/);
  assert.match(formatSummaryBanner(build({ laneReview: 'first-review' })), /run \/tokenmaxed:setup to review what each lane/);
  assert.doesNotMatch(formatSummaryBanner(build({ laneReview: 'current' })), /\/tokenmaxed:setup to review/);
  assert.doesNotMatch(formatSummaryBanner(build({})), /to review/); // absent ⇒ no hint
});

test('banner shows NO lane-review hint when there are no lanes (config-empty already nudges setup)', () => {
  const banner = formatSummaryBanner(build({ lanes: [], staleness: [], laneReview: 'changed' }));
  assert.doesNotMatch(banner, /lanes changed/);
});

test('banner shows a routing-OFF variant when disabled', () => {
  const banner = formatSummaryBanner(build({ enabled: false }));
  assert.match(banner, /routing is OFF/i);
  assert.doesNotMatch(banner, /Saved \$/); // no stats when off
});

test('banner flags the offline lane and names the reviewer', () => {
  const banner = formatSummaryBanner(build());
  assert.match(banner, /ollama-llama3 \(full\) ⚠ offline/); // non-reviewer lanes show trust_mode
  assert.match(banner, /codex-cli \(reviewer\)/);
});

// --- clampBanner (the SessionStart systemMessage UX guard) ---------------------

test('clampBanner is idempotent when the banner is already within budget', () => {
  const banner = formatSummaryBanner(build());
  assert.equal(clampBanner(banner), banner); // a normal banner is well under defaults
  assert.doesNotMatch(clampBanner(banner), /run \/tokenmaxed:summary for full detail/);
});

test('clampBanner trims to the line budget, drops the tips line FIRST, and keeps headline+windows+lanes', () => {
  // Force a tall banner: many stale lanes ⇒ many trailing spell-out lines.
  const manyStale = Array.from({ length: 8 }, (_, i) => ({
    laneId: i === 0 ? 'minimax-api' : `codex-cli`, // ids that exist in the fixture lanes
    newest: `m-${i}`,
    newestPriced: true,
  }));
  const banner = formatSummaryBanner(build({ staleness: manyStale }));
  const out = clampBanner(banner, { maxLines: 10, maxChars: 5000 });
  assert.ok(out.split('\n').length <= 10, 'within the line budget');
  assert.match(out, /run \/tokenmaxed:summary for full detail/); // pointer appended when trimmed
  assert.doesNotMatch(out, /\/tokenmaxed:summary anytime/); // the tips line is dropped first
  // Required content survives:
  assert.match(out, /TokenMaxed/);
  assert.match(out, /Lanes:/);
  assert.match(out, /24h/);
  assert.match(out, /lifetime/);
});

test('clampBanner enforces maxChars by ellipsizing the long Lanes line while keeping it present', () => {
  // A huge lane set makes the single `Lanes:` line very long; a feasible-but-tight
  // budget (bigger than the skeleton) ⇒ the Lanes line is ellipsized, not dropped.
  const bigLanes = Array.from({ length: 60 }, (_, i) =>
    lane({ id: `lane-${i}-with-a-fairly-long-identifier`, command: 'x' }),
  );
  const banner = formatSummaryBanner(build({ lanes: bigLanes, availableLaneIds: [], staleness: [] }));
  const out = clampBanner(banner, { maxLines: 12, maxChars: 600 });
  assert.ok(out.length <= 600, `must fit maxChars, got ${out.length}`);
  assert.match(out, /Lanes:/); // the line's presence is preserved
  assert.match(out, /…/); // ellipsized
});

test('clampBanner GUARANTEES maxChars as a true postcondition even for a pathologically tiny budget', () => {
  const banner = formatSummaryBanner(build()); // a normal multi-line banner
  for (const maxChars of [10, 40, 80, 120]) {
    const out = clampBanner(banner, { maxChars });
    assert.ok(out.length <= maxChars, `budget ${maxChars}: got ${out.length}`);
  }
  // Budgets are normalized to non-negative integers: zero, negative, and fractional
  // (< 1) all floor to 0 ⇒ empty string (no off-by-one '…' that would exceed budget).
  assert.equal(clampBanner(banner, { maxChars: 0 }), '');
  assert.equal(clampBanner('abcdef', { maxChars: 0 }), '');
  assert.equal(clampBanner(banner, { maxChars: -1 }), '');
  assert.equal(clampBanner('abcdef', { maxChars: -100 }), '');
  assert.equal(clampBanner('abcdef', { maxChars: 0.5 }), ''); // fractional < 1 → 0
  // A fractional budget >= 1 floors down, and the result still fits the floored budget.
  assert.ok(clampBanner(banner, { maxChars: 80.9 }).length <= 80);
});
