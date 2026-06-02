import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LedgerSummary, TokenStats } from '@tokenmaxed/core';

import {
  CliArgError,
  formatSavings,
  formatTokens,
  parseArgs,
  periodLabel,
  resolvePeriodSince,
} from '../src/render.ts';

test('parseArgs defaults to help with no args', () => {
  assert.deepEqual(parseArgs([]), { command: 'help', period: 'all', by: 'model' });
});

test('parseArgs reads command, period, by, and ledger', () => {
  assert.deepEqual(parseArgs(['tokens', '--period', '7d', '--by', 'lane', '--ledger', '/tmp/l.jsonl']), {
    command: 'tokens',
    period: '7d',
    by: 'lane',
    ledgerPath: '/tmp/l.jsonl',
  });
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
  assert.match(out, /Estimated \$160\.00 avoided vs the all-frontier baseline \(80\.0% of frontier cost\)/);
  assert.match(out, /Metered API — spent \$40\.00, avoided \$160\.00 \(80\.0%\)/);
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
