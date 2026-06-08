/**
 * Tests for the freshness orchestrator: which lanes it checks, live vs cache-only,
 * cache writes, and offline-keeps-cache — over an injected fetch + in-memory cache.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  renderModelIdMismatchWarnings,
  renderStalenessWarnings,
  reportFreshness,
  reportModelIdMismatches,
} from '../src/freshness-report.ts';
import type { ModelIdMismatchWarning } from '../src/freshness-report.ts';
import { emptyCache, getEntry, putEntry } from '../src/model-cache.ts';
import type { FreshnessCache } from '../src/model-cache.ts';
import type { ModelListResult } from '../src/model-list.ts';
import type { Lane, PriceTable } from '@tokenmaxed/core';

const table: PriceTable = {
  schema_version: 2,
  frontier_model: 'opus',
  models: {
    'minimax-m2': { inputPer1M: 0.3, outputPer1M: 1.2, family: 'minimax', released: '2025-10-01' },
    'minimax-m3': { inputPer1M: 0.5, outputPer1M: 2.0, family: 'minimax', released: '2026-06-01' },
    opus: { inputPer1M: 15, outputPer1M: 75 },
  },
};

const lane = (over: Partial<Lane> = {}): Lane => ({
  id: 'minimax-api', kind: 'api', model: 'minimax-m2', model_family: 'minimax', trust_mode: 'worker',
  costBasis: 'metered', provenance: 'minimax', jurisdiction: 'CN', endpoint: 'https://api.minimax.io/v1/chat/completions',
  authHandle: 'MINIMAX', ...over,
});

function deps(over: Partial<Parameters<typeof reportFreshness>[1]> = {}) {
  let cache: FreshnessCache = emptyCache();
  return {
    fetchList: async (): Promise<ModelListResult> => ({ status: 'ok', models: [{ id: 'minimax-m2', created: 100 }, { id: 'minimax-m3', created: 200 }] }),
    table,
    now: 1000,
    readCache: () => cache,
    writeCache: (c: FreshnessCache) => { cache = c; },
    ...over,
    _peek: () => cache,
  } as Parameters<typeof reportFreshness>[1] & { _peek: () => FreshnessCache };
}

test('warns on a stale pinned model and writes the live list to the cache', async () => {
  const d = deps();
  const warnings = await reportFreshness([lane()], d, { refresh: true });
  assert.deepEqual(warnings, [{ laneId: 'minimax-api', family: 'minimax', pinned: 'minimax-m2', newest: 'minimax-m3', newestPriced: true }]);
  assert.ok(getEntry((d as { _peek: () => FreshnessCache })._peek(), lane().endpoint!)); // cached
});

test('a concrete pin with NO model_family is still checked via the price-table family', async () => {
  // minimax-m2 is priced with family "minimax" in the table ⇒ staleness works even
  // though the lane omits model_family (no guessing — the family comes from the table).
  const warnings = await reportFreshness([lane({ model: 'minimax-m2', model_family: undefined })], deps(), { refresh: true });
  assert.deepEqual(warnings, [{ laneId: 'minimax-api', family: 'minimax', pinned: 'minimax-m2', newest: 'minimax-m3', newestPriced: true }]);
});

test('a concrete pin that is unpriced AND has no model_family is skipped (cannot judge)', async () => {
  let fetched = 0;
  const warnings = await reportFreshness([lane({ model: 'mystery-1', model_family: undefined })], deps({ fetchList: async () => { fetched++; return { status: 'ok', models: [] }; } }), { refresh: true });
  assert.deepEqual(warnings, []);
  assert.equal(fetched, 0); // no family known ⇒ skipped before any egress
});

test('no warning when the pinned model is already newest', async () => {
  const warnings = await reportFreshness([lane({ model: 'minimax-m3' })], deps(), { refresh: true });
  assert.deepEqual(warnings, []);
});

test('skips non-api lanes and lanes with no model_family (no egress)', async () => {
  const lanes = [
    lane({ id: 'l2', kind: 'cli', endpoint: undefined, command: 'x' }), // not api
    lane({ id: 'l3', model: 'mystery-x', model_family: undefined }), // unpriced pin, no family ⇒ unknown
  ];
  let fetched = 0;
  const warnings = await reportFreshness(lanes, deps({ fetchList: async () => { fetched++; return { status: 'ok-empty' }; } }), { refresh: true });
  assert.deepEqual(warnings, []);
  assert.equal(fetched, 0); // none eligible ⇒ no egress
});

test('a @latest lane is assessed at its RESOLVED model — flags a newer unpriced vendor model (pricing gap)', async () => {
  // minimax@latest resolves (price table) to minimax-m3; the vendor now reports an
  // unpriced minimax-m4 ⇒ status must surface the pricing-gap warning to close the loop.
  const warnings = await reportFreshness([lane({ model: 'minimax@latest', model_family: undefined })], deps({
    fetchList: async () => ({ status: 'ok', models: [{ id: 'minimax-m3', created: 200 }, { id: 'minimax-m4', created: 300 }] }),
  }), { refresh: true });
  assert.deepEqual(warnings, [{ laneId: 'minimax-api', family: 'minimax', pinned: 'minimax-m3', newest: 'minimax-m4', newestPriced: false }]);
});

test('a @latest lane is NOT flagged when its resolved model is the newest the vendor reports', async () => {
  const warnings = await reportFreshness([lane({ model: 'minimax@latest', model_family: undefined })], deps({
    fetchList: async () => ({ status: 'ok', models: [{ id: 'minimax-m2', created: 100 }, { id: 'minimax-m3', created: 200 }] }),
  }), { refresh: true });
  assert.deepEqual(warnings, []); // resolves to m3, which is newest ⇒ fresh
});

test('refresh:false is STRICTLY cache-only — never fetches, even when cache is fresh', async () => {
  let fetched = 0;
  let cache = putEntry(emptyCache(), lane().endpoint!, [{ id: 'minimax-m2' }, { id: 'minimax-m3' }], 1000);
  const warnings = await reportFreshness([lane()], {
    fetchList: async () => { fetched++; return { status: 'offline' }; },
    table, now: 1500, readCache: () => cache, writeCache: (c) => { cache = c; },
  }, { refresh: false });
  assert.equal(fetched, 0); // cache-only ⇒ no fetch
  assert.equal(warnings.length, 1); // still detects staleness from the cached list
});

test('refresh:false makes NO call even when the cache is missing or expired (no passive egress)', async () => {
  let fetched = 0;
  const missing = await reportFreshness([lane()], {
    fetchList: async () => { fetched++; return { status: 'ok', models: [] }; },
    table, now: 9_999_999, readCache: () => emptyCache(), writeCache: () => {},
  }, { refresh: false });
  assert.equal(fetched, 0); // missing cache ⇒ STILL no fetch
  assert.deepEqual(missing, []); // no data ⇒ unknown ⇒ no warning
});

test('offline (refresh:true) keeps the cached list rather than dropping to unknown', async () => {
  let cache = putEntry(emptyCache(), lane().endpoint!, [{ id: 'minimax-m2' }, { id: 'minimax-m3' }], 0);
  const warnings = await reportFreshness([lane()], {
    fetchList: async () => ({ status: 'offline' }),
    table, now: 999_999, readCache: () => cache, writeCache: (c) => { cache = c; },
  }, { refresh: true });
  assert.equal(warnings.length, 1); // refresh fails offline ⇒ falls back to cached models
});

test('renderStalenessWarnings distinguishes priced vs pricing-gap', () => {
  const priced = renderStalenessWarnings([{ laneId: 'l', family: 'minimax', pinned: 'minimax-m2', newest: 'minimax-m3', newestPriced: true }]);
  assert.match(priced[0]!, /newer available: minimax-m3/);
  const gap = renderStalenessWarnings([{ laneId: 'l', family: 'minimax', pinned: 'minimax-m2', newest: 'minimax-m9', newestPriced: false }]);
  assert.match(gap[0]!, /isn't priced yet/);
});

// --- reportModelIdMismatches: universal "vendor will reject this id" guard ---------

const MM_ENDPOINT = 'https://api.minimax.io/v1/chat/completions';

test('reportModelIdMismatches flags a casing mismatch with the vendor exact id', async () => {
  // Exact-casing concrete pin ⇒ no warning.
  const okCache = putEntry(emptyCache(), MM_ENDPOINT, [{ id: 'MiniMax-M3' }], 1000);
  assert.deepEqual(
    await reportModelIdMismatches([lane({ model: 'MiniMax-M3' })], { table, now: 1000, ttlMs: 10_000, readCache: () => okCache }),
    [],
  );
  // Lowercase concrete pin vs the vendor's CamelCase id ⇒ one casing warning.
  const badCache = putEntry(emptyCache(), MM_ENDPOINT, [{ id: 'MiniMax-M3' }], 1000);
  assert.deepEqual(
    await reportModelIdMismatches([lane({ model: 'minimax-m3' })], { table, now: 1000, ttlMs: 10_000, readCache: () => badCache }),
    [{ laneId: 'minimax-api', sent: 'minimax-m3', vendorId: 'MiniMax-M3' }],
  );
});

test('reportModelIdMismatches skips a lane with a stale (TTL-expired) cache entry', async () => {
  const cache = putEntry(emptyCache(), MM_ENDPOINT, [{ id: 'MiniMax-M3' }], 0);
  assert.deepEqual(
    await reportModelIdMismatches([lane({ model: 'minimax-m3' })], { table, now: 100_000, ttlMs: 10_000, readCache: () => cache }),
    [],
  );
});

test('reportModelIdMismatches resolves @latest to the priced id before checking', async () => {
  // @latest resolves (price table) to minimax-m3; vendor lists MiniMax-M3 ⇒ casing warning.
  const cache = putEntry(emptyCache(), MM_ENDPOINT, [{ id: 'MiniMax-M3' }], 1000);
  assert.deepEqual(
    await reportModelIdMismatches([lane({ model: 'minimax@latest' })], { table, now: 1000, ttlMs: 10_000, readCache: () => cache }),
    [{ laneId: 'minimax-api', sent: 'minimax-m3', vendorId: 'MiniMax-M3' }],
  );
});

test('renderModelIdMismatchWarnings renders casing-fix and absent lines', () => {
  const casing: ModelIdMismatchWarning[] = [{ laneId: 'l', sent: 'minimax-m3', vendorId: 'MiniMax-M3' }];
  const [line] = renderModelIdMismatchWarnings(casing);
  assert.match(line!, /will be REJECTED/);
  assert.ok(line!.includes('minimax-m3') && line!.includes('MiniMax-M3'));
  const absent = renderModelIdMismatchWarnings([{ laneId: 'l', sent: 'gpt-9' }]);
  assert.match(absent[0]!, /not in the vendor's live model list/);
});
