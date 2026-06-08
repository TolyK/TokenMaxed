import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregateSavings,
  computeCostPrimitives,
  PriceError,
  priceForModel,
  validatePriceTable,
} from '../src/price.ts';
import type { CostPrimitives, PriceTable } from '../src/price.ts';
import { loadPriceTable } from '../src/node.ts';
import type { Usage } from '../src/types.ts';

const TABLE: PriceTable = {
  schema_version: 1,
  frontier_model: 'claude-opus-4-7',
  models: {
    'claude-opus-4-7': { inputPer1M: 15, outputPer1M: 75 },
    'gpt-5.5': { inputPer1M: 10, outputPer1M: 30 },
    'llama3.1:8b': { inputPer1M: 0, outputPer1M: 0 },
  },
};

// 2M input + 1M output → opus: 2*15 + 1*75 = 105; gpt-5.5: 2*10 + 1*30 = 50; llama: 0.
const USAGE: Usage = { tokens_in: 2_000_000, tokens_out: 1_000_000 };

test('priceForModel computes exact list price from per-1M rates', () => {
  assert.equal(priceForModel(TABLE, 'claude-opus-4-7', USAGE), 105);
  assert.equal(priceForModel(TABLE, 'gpt-5.5', USAGE), 50);
  assert.equal(priceForModel(TABLE, 'llama3.1:8b', USAGE), 0);
});

test('priceForModel prices all input tokens at the input rate (no off-provider cache discount)', () => {
  // Cache-read/write tokens are folded into tokens_in (P1-S5); there is no
  // cache-discount path, so they are priced exactly as normal input.
  assert.equal(priceForModel(TABLE, 'claude-opus-4-7', { tokens_in: 1_000_000, tokens_out: 0 }), 15);
});

test('priceForModel throws for an unknown model', () => {
  assert.throws(() => priceForModel(TABLE, 'mystery', USAGE), {
    name: 'PriceError',
    message: /No price for model "mystery"/,
  });
});

test('priceForModel rejects a model id colliding with a prototype key (no NaN)', () => {
  for (const model of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    assert.throws(() => priceForModel(TABLE, model, USAGE), {
      name: 'PriceError',
      message: /No price for model/,
    });
  }
});

test('validatePriceTable rejects a frontier_model that is only a prototype key', () => {
  assert.throws(
    () => validatePriceTable({ schema_version: 1, frontier_model: 'constructor', models: {} }),
    { name: 'PriceError', message: /frontier_model "constructor" has no entry/ },
  );
});

test('priceForModel rejects negative or non-finite usage', () => {
  assert.throws(() => priceForModel(TABLE, 'gpt-5.5', { tokens_in: -1, tokens_out: 0 }), PriceError);
  assert.throws(
    () => priceForModel(TABLE, 'gpt-5.5', { tokens_in: Number.NaN, tokens_out: 0 }),
    PriceError,
  );
});

test('computeCostPrimitives: subscription lane has zero marginal cost', () => {
  const p = computeCostPrimitives(TABLE, { model: 'claude-opus-4-7', costBasis: 'subscription' }, USAGE);
  assert.deepEqual(p, {
    frontier_cost: 105,
    actual_cost: 0,
    metered_spent: 0,
    frontier_avoided: 105,
    metered_avoided: 105,
  });
});

test('computeCostPrimitives: local lane is free but still has frontier_cost', () => {
  const p = computeCostPrimitives(TABLE, { model: 'llama3.1:8b', costBasis: 'local' }, USAGE);
  assert.equal(p.frontier_cost, 105);
  assert.equal(p.actual_cost, 0);
  assert.equal(p.metered_spent, 0);
  assert.equal(p.frontier_avoided, 105);
});

test('computeCostPrimitives: metered lane is priced and counts as metered spend', () => {
  const p = computeCostPrimitives(TABLE, { model: 'gpt-5.5', costBasis: 'metered' }, USAGE);
  assert.deepEqual(p, {
    frontier_cost: 105,
    actual_cost: 50,
    metered_spent: 50,
    frontier_avoided: 55,
    metered_avoided: 55,
  });
});

test('aggregateSavings computes the canonical percentages (Σ frontier_cost denominator)', () => {
  const rows: CostPrimitives[] = [
    { frontier_cost: 100, actual_cost: 0, metered_spent: 0, frontier_avoided: 100, metered_avoided: 100 },
    { frontier_cost: 100, actual_cost: 40, metered_spent: 40, frontier_avoided: 60, metered_avoided: 60 },
  ];
  const s = aggregateSavings(rows);
  assert.equal(s.frontier_cost, 200);
  assert.equal(s.frontier_avoided, 160);
  assert.equal(s.metered_spent, 40);
  assert.equal(s.metered_avoided, 160);
  assert.equal(s.frontier_avoided_pct, 80);
  assert.equal(s.metered_avoided_pct, 80);
});

test('aggregateSavings derives the two percentages from independent fields', () => {
  // Synthetic row where metered_avoided differs from frontier_avoided proves the
  // aggregator reads the right field for each percentage.
  const rows: CostPrimitives[] = [
    { frontier_cost: 100, actual_cost: 0, metered_spent: 10, frontier_avoided: 100, metered_avoided: 90 },
  ];
  const s = aggregateSavings(rows);
  assert.equal(s.frontier_avoided_pct, 100);
  assert.equal(s.metered_avoided_pct, 90);
});

test('aggregateSavings guards Σ frontier_cost == 0 (no divide-by-zero)', () => {
  const empty = aggregateSavings([]);
  assert.equal(empty.frontier_avoided_pct, 0);
  assert.equal(empty.metered_avoided_pct, 0);
  const allZero = aggregateSavings([
    { frontier_cost: 0, actual_cost: 0, metered_spent: 0, frontier_avoided: 0, metered_avoided: 0 },
  ]);
  assert.equal(allZero.frontier_avoided_pct, 0);
  assert.equal(allZero.metered_avoided_pct, 0);
});

test('validatePriceTable accepts a well-formed table', () => {
  const t = validatePriceTable({
    schema_version: 1,
    frontier_model: 'm',
    models: { m: { inputPer1M: 1, outputPer1M: 2 } },
  });
  assert.equal(t.frontier_model, 'm');
  assert.equal(t.models.m?.outputPer1M, 2);
});

test('validatePriceTable rejects a frontier_model missing from models', () => {
  assert.throws(
    () => validatePriceTable({ schema_version: 1, frontier_model: 'nope', models: {} }),
    { name: 'PriceError', message: /frontier_model "nope" has no entry/ },
  );
});

test('validatePriceTable rejects a negative price', () => {
  assert.throws(
    () =>
      validatePriceTable({
        schema_version: 1,
        frontier_model: 'm',
        models: { m: { inputPer1M: -1, outputPer1M: 2 } },
      }),
    { name: 'PriceError', message: /inputPer1M must be a finite number >= 0/ },
  );
});

test('validatePriceTable rejects a non-object', () => {
  assert.throws(() => validatePriceTable(null), { message: /must be a JSON object/ });
  assert.throws(() => validatePriceTable('x'), { message: /must be a JSON object/ });
});

test('loadPriceTable reads and validates the shipped seed file', () => {
  const seedPath = new URL('../../../config/prices.seed.json', import.meta.url);
  const t = loadPriceTable(seedPath);
  // MODEL-FRESHNESS: the frontier baseline tracks the current most-capable Claude
  // (claude-opus-4-8); the previous frontier stays priced for back-compat.
  assert.equal(t.frontier_model, 'claude-opus-4-8');
  assert.equal(t.schema_version, 2); // MODEL-FRESHNESS: metadata-carrying seed
  assert.equal(Object.keys(t.models).length, 11);
  assert.equal(t.models['claude-opus-4-8']?.inputPer1M, 5);
  assert.equal(t.models['claude-opus-4-8']?.outputPer1M, 25);
  assert.equal(t.models['claude-opus-4-8']?.family, 'claude-opus');
  assert.equal(t.models['claude-opus-4-7']?.inputPer1M, 15);
  // Sonnet 4.6 priced + family-tagged so claude-sonnet@latest resolves to it.
  assert.equal(t.models['claude-sonnet-4-6']?.inputPer1M, 3);
  assert.equal(t.models['claude-sonnet-4-6']?.outputPer1M, 15);
  assert.equal(t.models['claude-sonnet-4-6']?.family, 'claude-sonnet');
  assert.equal(t.models['claude-haiku-4-5-20251001']?.outputPer1M, 5);
  // F2-S5: metered vendor models priced so opted-up reader/worker lanes are routable.
  assert.ok(t.models['glm-5.1']);
  // Vendor-EXACT id casing (the provider's /models ids are CamelCase: MiniMax-M3) so a
  // resolved `@latest` is accepted verbatim by the API — a lowercase key would 400.
  assert.ok(t.models['MiniMax-M2']);
  // MODEL-FRESHNESS: the family advanced to M3, now priced + tagged so @latest can
  // resolve to it and staleness can be detected against the explicit family.
  assert.ok(t.models['MiniMax-M3']);
  assert.equal(t.models['MiniMax-M2']?.family, 'minimax');
  assert.equal(t.models['MiniMax-M3']?.family, 'minimax');
  assert.ok(t.models['MiniMax-M3']?.released);
});

test('loadPriceTable gives a clear error for a missing file', () => {
  assert.throws(() => loadPriceTable('/no/such/prices.json'), {
    name: 'PriceError',
    message: /Could not read price table/,
  });
});
