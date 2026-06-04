/**
 * Tests for the pure model-freshness primitives: alias parsing, natural version
 * ordering, and newest-priced-in-family selection (the pricing-safe @latest floor).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseModelAlias,
  compareModelVersion,
  compareNewestFirst,
  pricedIdsInFamily,
  newestPricedInFamily,
} from '../src/model-freshness.ts';
import type { PriceTable } from '../src/price.ts';

test('parseModelAlias recognizes <family>@latest and concrete ids', () => {
  assert.deepEqual(parseModelAlias('minimax@latest'), { latest: true, family: 'minimax' });
  assert.deepEqual(parseModelAlias('  glm@latest '), { latest: true, family: 'glm' });
  assert.deepEqual(parseModelAlias('minimax-m2'), { latest: false, id: 'minimax-m2' });
  // A bare "@latest" with no family is treated as a concrete id (no empty family).
  assert.deepEqual(parseModelAlias('@latest'), { latest: false, id: '@latest' });
});

test('compareModelVersion orders versions numerically, not lexically', () => {
  assert.ok(compareModelVersion('minimax-m2', 'minimax-m3') < 0);
  assert.ok(compareModelVersion('minimax-m3', 'minimax-m2') > 0);
  assert.ok(compareModelVersion('m2', 'm2.5') < 0);
  assert.ok(compareModelVersion('m2.5', 'm3') < 0);
  assert.ok(compareModelVersion('m2', 'm10') < 0); // numeric, not string ("10" < "2" lexically)
  assert.equal(compareModelVersion('minimax-m3', 'minimax-m3'), 0);
});

const table: PriceTable = {
  schema_version: 2,
  frontier_model: 'opus',
  models: {
    'minimax-m2': { inputPer1M: 0.3, outputPer1M: 1.2, family: 'minimax', released: '2025-10-01' },
    'minimax-m3': { inputPer1M: 0.5, outputPer1M: 2.0, family: 'minimax', released: '2026-06-01' },
    'glm-5.1': { inputPer1M: 0.6, outputPer1M: 2.2, family: 'glm', released: '2026-04-01' },
    opus: { inputPer1M: 15, outputPer1M: 75 }, // no family metadata
  },
};

test('pricedIdsInFamily matches the EXPLICIT family field only (no prefix guessing)', () => {
  assert.deepEqual(pricedIdsInFamily(table, 'minimax').sort(), ['minimax-m2', 'minimax-m3']);
  assert.deepEqual(pricedIdsInFamily(table, 'glm'), ['glm-5.1']);
  assert.deepEqual(pricedIdsInFamily(table, 'nope'), []);
});

test('compareNewestFirst orders by release date (newest first)', () => {
  assert.ok(compareNewestFirst(table, 'minimax-m3', 'minimax-m2') < 0); // m3 sorts before m2
  assert.ok(compareNewestFirst(table, 'minimax-m2', 'minimax-m3') > 0);
});

test('newestPricedInFamily returns the newest priced same-family id, else undefined', () => {
  assert.equal(newestPricedInFamily(table, 'minimax'), 'minimax-m3');
  assert.equal(newestPricedInFamily(table, 'glm'), 'glm-5.1');
  assert.equal(newestPricedInFamily(table, 'unpriced-family'), undefined);
});

test('newestPricedInFamily falls back to version order when releases are absent', () => {
  const noDates: PriceTable = {
    schema_version: 2,
    frontier_model: 'x',
    models: {
      'foo-2': { inputPer1M: 1, outputPer1M: 1, family: 'foo' },
      'foo-10': { inputPer1M: 1, outputPer1M: 1, family: 'foo' },
      x: { inputPer1M: 1, outputPer1M: 1 },
    },
  };
  assert.equal(newestPricedInFamily(noDates, 'foo'), 'foo-10'); // 10 > 2 numerically
});
