import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LedgerSummary, OutcomeStats, TokenStats } from '@tokenmaxed/core';

import {
  CliArgError,
  formatLanes,
  formatLeaderboard,
  formatOutcomes,
  formatSavings,
  formatTokens,
  parseArgs,
  periodLabel,
  resolvePeriodSince,
} from '../src/render.ts';
import type { LeaderboardRow } from '@tokenmaxed/core';
import type { LaneView } from '../src/render.ts';

test('parseArgs defaults to help with no args', () => {
  assert.deepEqual(parseArgs([]), {
    command: 'help',
    period: 'all',
    by: 'model',
    leaderboardBy: 'performance',
    json: false,
  });
});

test('parseArgs reads command, period, by, and ledger', () => {
  assert.deepEqual(parseArgs(['tokens', '--period', '7d', '--by', 'lane', '--ledger', '/tmp/l.jsonl']), {
    command: 'tokens',
    period: '7d',
    by: 'lane',
    leaderboardBy: 'performance',
    json: false,
    ledgerPath: '/tmp/l.jsonl',
  });
});

test('parseArgs accepts the outcomes and lanes commands (+ --lanes)', () => {
  assert.equal(parseArgs(['outcomes']).command, 'outcomes');
  assert.deepEqual(parseArgs(['lanes', '--lanes', '/tmp/lanes.yaml']), {
    command: 'lanes',
    period: 'all',
    by: 'model',
    leaderboardBy: 'performance',
    json: false,
    lanesPath: '/tmp/lanes.yaml',
  });
});

test('parseArgs accepts leaderboard sort axis and --json', () => {
  assert.deepEqual(parseArgs(['leaderboard', '--by', 'tokens', '--json']), {
    command: 'leaderboard',
    period: 'all',
    by: 'model',
    leaderboardBy: 'tokens',
    json: true,
  });
  assert.throws(() => parseArgs(['leaderboard', '--by', 'lane']), { message: /--by must be/ });
});

test('parseArgs rejects bad input', () => {
  assert.throws(() => parseArgs(['frobnicate']), { name: 'CliArgError', message: /Unknown command/ });
  assert.throws(() => parseArgs(['tokens', '--by', 'galaxy']), { message: /--by must be/ });
  assert.throws(() => parseArgs(['savings', '--period']), { message: /Missing value/ });
  assert.throws(() => parseArgs(['--nope']), { message: /Unknown option/ });
  assert.throws(() => parseArgs(['savings', 'tokens']), { message: /Unexpected argument/ });
});

test('parseArgs treats -h/--help as help regardless of position', () => {
  assert.equal(parseArgs(['tokens', '--help']).command, 'help');
  assert.equal(parseArgs(['-h']).command, 'help');
});

test('resolvePeriodSince handles all and relative windows', () => {
  const now = Date.parse('2026-06-10T00:00:00.000Z');
  assert.equal(resolvePeriodSince('all', now), undefined);
  assert.equal(resolvePeriodSince('7d', now), '2026-06-03T00:00:00.000Z');
  assert.equal(resolvePeriodSince('24h', now), '2026-06-09T00:00:00.000Z');
  assert.throws(() => resolvePeriodSince('soon', now), { name: 'CliArgError' });
});

test('periodLabel reads naturally', () => {
  assert.equal(periodLabel('all'), 'all time');
  assert.equal(periodLabel('7d'), 'last 7d');
});

function summary(over: Partial<LedgerSummary> = {}): LedgerSummary {
  return {
    events: 3,
    savings: {
      frontier_cost: 200,
      frontier_avoided: 160,
      metered_spent: 40,
      metered_avoided: 160,
      frontier_avoided_pct: 80,
      metered_avoided_pct: 80,
    },
    actual_cost: 40,
    metered_spent_total: 40,
    laneMix: { 'codex-cli': 2, 'ollama': 1 },
    blockCount: 0,
    nativeFallbacks: 0,
    ...over,
  };
}

function stats(): TokenStats {
  return {
    total: { in: 310, out: 60, total: 370, estimated: { in: 210, out: 10, total: 220 }, reported: { in: 100, out: 50, total: 150 } },
    byModel: {
      'gpt-5.5': { in: 110, out: 60, total: 170, estimated: { in: 10, out: 10, total: 20 }, reported: { in: 100, out: 50, total: 150 }, events: 2 },
      'llama3.1:8b': { in: 200, out: 0, total: 200, estimated: { in: 200, out: 0, total: 200 }, reported: { in: 0, out: 0, total: 0 }, events: 1 },
    },
    byLane: {
      'codex-cli': { in: 110, out: 60, total: 170, estimated: { in: 10, out: 10, total: 20 }, reported: { in: 100, out: 50, total: 150 }, events: 2 },
      'ollama': { in: 200, out: 0, total: 200, estimated: { in: 200, out: 0, total: 200 }, reported: { in: 0, out: 0, total: 0 }, events: 1 },
    },
  };
}

test('formatSavings shows the honest, labeled headline and a usage-not-$ token block', () => {
  const out = formatSavings({ summary: summary(), tokens: stats(), periodLabel: 'all time' });
  // Headline = honest finance-grade (actual spend + metered avoided).
  assert.match(out, /Actual API spend \$40\.00 — saved \$160\.00 \(80\.0% of the frontier-equivalent cost\)/);
  // All-frontier baseline demoted to a clearly-labeled hypothetical.
  assert.match(out, /Baseline context: \$160\.00 avoided vs an all-frontier baseline \(80\.0%\) — a hypothetical ceiling/);
  // The headline (actual spend) appears before the baseline context line.
  assert.ok(out.indexOf('Actual API spend') < out.indexOf('Baseline context'));
  assert.match(out, /Tokens \(usage, not \$\)/);
  // Top model sorted by total desc: llama3.1:8b (200) before gpt-5.5 (170).
  const llamaIdx = out.indexOf('llama3.1:8b');
  const gptIdx = out.indexOf('gpt-5.5');
  assert.ok(llamaIdx > -1 && gptIdx > -1 && llamaIdx < gptIdx);
  assert.match(out, /estimated/); // llama tokens are estimated
  assert.match(out, /full breakdown: tokenmaxed tokens/);
});

test('formatSavings handles an empty ledger gracefully', () => {
  const empty = summary({ events: 0, laneMix: {}, savings: {
    frontier_cost: 0, frontier_avoided: 0, metered_spent: 0, metered_avoided: 0,
    frontier_avoided_pct: 0, metered_avoided_pct: 0,
  } });
  const out = formatSavings({ summary: empty, tokens: stats(), periodLabel: 'all time' });
  assert.match(out, /No tasks recorded yet/);
});

test('formatTokens renders a per-model table that totals correctly', () => {
  const out = formatTokens({ tokens: stats(), by: 'model', periodLabel: 'all time' });
  assert.match(out, /by model/);
  assert.match(out, /gpt-5\.5/);
  assert.match(out, /llama3\.1:8b/);
  assert.match(out, /total/);
  // The grand total row carries the overall totals.
  assert.match(out, /370/);
});

test('formatTokens by lane lists lanes including the $0 local one', () => {
  const out = formatTokens({ tokens: stats(), by: 'lane', periodLabel: 'all time' });
  assert.match(out, /by lane/);
  assert.match(out, /ollama/);
  assert.match(out, /codex-cli/);
});

test('formatOutcomes renders verdict tallies + success rate per lane', () => {
  const outcomes: OutcomeStats = {
    total: { pass: 2, needs_rework: 1, fail: 1, total: 4, success_rate: 0.625 },
    byLane: {
      'worker-a': { pass: 1, needs_rework: 1, fail: 1, total: 3, success_rate: 0.5 },
      '(host)': { pass: 1, needs_rework: 0, fail: 0, total: 1, success_rate: 1 },
    },
    escalation: { offloadsReviewed: 0, escalated: 0, rate: 0 },
  };
  const out = formatOutcomes({ outcomes, periodLabel: 'all time' });
  assert.match(out, /outcomes \(all time\)/);
  assert.match(out, /worker-a/);
  assert.match(out, /\(host\)/);
  assert.match(out, /50\.0%/); // worker-a success rate
  assert.match(out, /total/);
});

test('formatOutcomes handles no reviews', () => {
  const empty: OutcomeStats = {
    total: { pass: 0, needs_rework: 0, fail: 0, total: 0, success_rate: 0 },
    byLane: {},
    escalation: { offloadsReviewed: 0, escalated: 0, rate: 0 },
  };
  assert.match(formatOutcomes({ outcomes: empty, periodLabel: 'all time' }), /No reviews recorded yet/);
});

function leaderboardRow(over: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    model: 'gpt-5-codex',
    category: 'bugfix',
    difficulty: 'easy',
    pass: 2,
    needs_rework: 1,
    fail: 1,
    total: 4,
    passRate: 0.625,
    tokens_in: 300,
    tokens_out: 120,
    users: 1,
    ...over,
  };
}

test('formatLeaderboard renders the table with caveat and columns', () => {
  const out = formatLeaderboard({
    rows: [leaderboardRow()],
    periodLabel: 'all time',
    sortBy: 'performance',
  });
  assert.match(out, /leaderboard \(all time, by performance\)/);
  assert.match(out, /gpt-5-codex/);
  assert.match(out, /62\.5%/);
  assert.match(out, /2\/1\/1/);
  assert.match(out, /300/);
  assert.match(out, /not ground-truth capability/);
  assert.match(out, /N = contributing users/);
});

test('formatLeaderboard --json emits rows as JSON', () => {
  const rows = [leaderboardRow({ model: 'claude-opus-4-8' })];
  const out = formatLeaderboard({ rows, periodLabel: 'all time', sortBy: 'tokens', json: true });
  assert.deepEqual(JSON.parse(out.trim()), rows);
});

test('formatLeaderboard handles no rows', () => {
  assert.match(
    formatLeaderboard({ rows: [], periodLabel: 'all time', sortBy: 'performance' }),
    /No attributable reviews recorded yet/,
  );
});

test('formatLanes shows trust mode, exec mode, roles, and manager eligibility', () => {
  const views: LaneView[] = [
    { id: 'claude-native', kind: 'cli', model: 'claude-opus-4-7', trust_mode: 'full', roles: ['manager'], managerEligible: true, executionMode: 'answer-only' },
    { id: 'deepseek-api', kind: 'api', model: 'deepseek-v3', trust_mode: 'worker', roles: [], managerEligible: false, executionMode: 'answer-only' },
  ];
  const out = formatLanes(views);
  assert.match(out, /claude-native/);
  assert.match(out, /full/);
  assert.match(out, /eligible/);
  assert.match(out, /worker/);
  assert.match(out, /\bno\b/);
});
