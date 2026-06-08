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
  resolveLaneModel,
  staleAgainstPriceTable,
  sameFamily,
  assessStaleness,
  detectModelIdMismatch,
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

test('resolveLaneModel resolves <family>@latest to the newest priced id', () => {
  assert.equal(resolveLaneModel({ model: 'minimax@latest' }, table).model, 'minimax-m3');
  // Concrete (non-alias) lanes are returned unchanged.
  assert.equal(resolveLaneModel({ model: 'minimax-m2' }, table).model, 'minimax-m2');
  // An alias with no priced family member stays @latest (caller's filter drops it).
  assert.equal(resolveLaneModel({ model: 'unpriced@latest' }, table).model, 'unpriced@latest');
  // Preserves other lane fields on the clone.
  assert.deepEqual(resolveLaneModel({ id: 'x', model: 'minimax@latest' }, table), { id: 'x', model: 'minimax-m3' });
});

test('sameFamily matches on an exact id or a boundary, never a partial prefix', () => {
  assert.equal(sameFamily('minimax-m3', 'minimax'), true);
  assert.equal(sameFamily('minimax', 'minimax'), true);
  assert.equal(sameFamily('minimax.5', 'minimax'), true);
  assert.equal(sameFamily('minimaxx', 'minimax'), false); // 'x' is alnum ⇒ not a boundary
  assert.equal(sameFamily('glm-5.1', 'minimax'), false);
});

test('assessStaleness: fresh when pinned is the newest same-family model', () => {
  const remote = [{ id: 'minimax-m2', created: 100 }, { id: 'minimax-m3', created: 200 }];
  assert.deepEqual(assessStaleness('minimax-m3', 'minimax', remote, table), { status: 'fresh' });
});

test('assessStaleness: stale when a newer same-family model exists (priced flag set)', () => {
  const remote = [{ id: 'minimax-m2', created: 100 }, { id: 'minimax-m3', created: 200 }];
  assert.deepEqual(assessStaleness('minimax-m2', 'minimax', remote, table), {
    status: 'stale',
    newest: 'minimax-m3',
    newestPriced: true, // m3 is in the table
  });
});

test('assessStaleness: stale + newestPriced=false when the newer model is unpriced', () => {
  const remote = [{ id: 'minimax-m2', created: 100 }, { id: 'minimax-m9', created: 300 }];
  assert.deepEqual(assessStaleness('minimax-m2', 'minimax', remote, table), {
    status: 'stale',
    newest: 'minimax-m9', // not in the table ⇒ pricing gap
    newestPriced: false,
  });
});

test('assessStaleness: unknown when the remote list has no same-family model', () => {
  assert.deepEqual(assessStaleness('minimax-m2', 'minimax', [{ id: 'glm-5.1' }], table), { status: 'unknown' });
});

test('assessStaleness falls back to version order when created is absent', () => {
  const remote = [{ id: 'minimax-m2' }, { id: 'minimax-m10' }];
  const r = assessStaleness('minimax-m2', 'minimax', remote, table);
  assert.equal(r.status, 'stale');
  assert.equal(r.status === 'stale' && r.newest, 'minimax-m10'); // 10 > 2 numerically
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

// --- staleAgainstPriceTable: the egress-free "are the latest models in use?" check ---

test('staleAgainstPriceTable flags a concrete pin behind the newest priced in family', () => {
  // Covers ANY lane kind — here a cli lane pinned to an older minimax.
  const found = staleAgainstPriceTable([{ id: 'l', model: 'minimax-m2' }], table);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { laneId: 'l', family: 'minimax', pinned: 'minimax-m2', newest: 'minimax-m3' });
});

test('staleAgainstPriceTable does NOT flag a lane already on the newest priced model', () => {
  assert.deepEqual(staleAgainstPriceTable([{ id: 'l', model: 'minimax-m3' }], table), []);
});

test('staleAgainstPriceTable never flags a <family>@latest lane (it resolves to newest)', () => {
  // This is why @latest is the fix: a self-updating lane is never "behind".
  assert.deepEqual(staleAgainstPriceTable([{ id: 'l', model: 'minimax@latest' }], table), []);
});

test('staleAgainstPriceTable skips a pin with no resolvable family (no prefix guessing)', () => {
  // `opus` has no family metadata and the lane sets no model_family ⇒ cannot judge.
  assert.deepEqual(staleAgainstPriceTable([{ id: 'l', model: 'opus' }], table), []);
});

test('staleAgainstPriceTable uses an explicit model_family to judge an unpriced pin', () => {
  const found = staleAgainstPriceTable([{ id: 'l', model: 'minimax-m1', model_family: 'minimax' }], table);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.pinned, 'minimax-m1');
  assert.equal(found[0]!.newest, 'minimax-m3');
});

// --- detectModelIdMismatch (universal vendor-id guard) + case-insensitive family ---

test('detectModelIdMismatch: exact-casing member ⇒ null', () => {
  assert.equal(detectModelIdMismatch('MiniMax-M3', [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M2' }]), null);
});

test("detectModelIdMismatch: casing mismatch ⇒ reports the vendor's exact id", () => {
  assert.deepEqual(detectModelIdMismatch('minimax-m3', [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M2' }]), {
    sent: 'minimax-m3',
    vendorId: 'MiniMax-M3',
  });
});

test('detectModelIdMismatch: absent id ⇒ {sent} with no vendorId', () => {
  assert.deepEqual(detectModelIdMismatch('gpt-9', [{ id: 'MiniMax-M3' }]), { sent: 'gpt-9' });
});

test('detectModelIdMismatch: empty remote ⇒ null (cannot judge)', () => {
  assert.equal(detectModelIdMismatch('x', []), null);
});

test('sameFamily is case-insensitive', () => {
  assert.equal(sameFamily('MiniMax-M3', 'minimax'), true);
  assert.equal(sameFamily('MINIMAX', 'minimax'), true);
  assert.equal(sameFamily('glm-5.1', 'minimax'), false);
});
