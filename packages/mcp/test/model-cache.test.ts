/**
 * Tests for the model-freshness cache: pure put/get/freshness + coercion of bad
 * data, and round-trip file I/O.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  coerceCache,
  emptyCache,
  getEntry,
  isFresh,
  putEntry,
  readFreshnessCache,
  writeFreshnessCache,
} from '../src/model-cache.ts';

const EP = 'https://api.x.com/v1/chat/completions';

test('putEntry/getEntry round-trip without mutating the input', () => {
  const c0 = emptyCache();
  const c1 = putEntry(c0, EP, [{ id: 'glm-6', created: 2 }], 1000);
  assert.equal(getEntry(c0, EP), undefined); // original untouched
  assert.deepEqual(getEntry(c1, EP), { models: [{ id: 'glm-6', created: 2 }], checkedAt: 1000 });
});

test('isFresh respects the TTL window and rejects future timestamps', () => {
  const entry = { models: [], checkedAt: 1000 };
  assert.equal(isFresh(entry, 1500, 1000), true); // within TTL
  assert.equal(isFresh(entry, 2500, 1000), false); // expired
  assert.equal(isFresh(entry, 900, 1000), false); // clock went backwards ⇒ stale
  assert.equal(isFresh(undefined, 1000, 1000), false);
});

test('coerceCache drops wrong-version / malformed data', () => {
  assert.deepEqual(coerceCache({ version: 99, endpoints: {} }).endpoints, emptyCache().endpoints);
  assert.deepEqual(coerceCache('nonsense').endpoints, emptyCache().endpoints);
  const good = coerceCache({ version: 1, endpoints: { [EP]: { models: [{ id: 'a' }, { bad: 1 }], checkedAt: 5 } } });
  assert.deepEqual(getEntry(good, EP), { models: [{ id: 'a' }], checkedAt: 5 }); // bad model entry dropped
});

test('coerceCache drops a non-finite created (keeps the id)', () => {
  const c = coerceCache({ version: 1, endpoints: { [EP]: { models: [{ id: 'a', created: Infinity }, { id: 'b', created: 3 }], checkedAt: 5 } } });
  assert.deepEqual(getEntry(c, EP)?.models, [{ id: 'a' }, { id: 'b', created: 3 }]);
});

test('read/write round-trips through a file; missing file ⇒ empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-mcache-'));
  const path = join(dir, 'sub', 'freshness.json'); // nested ⇒ exercises mkdir
  assert.deepEqual(readFreshnessCache(path).endpoints, emptyCache().endpoints);
  writeFreshnessCache(path, putEntry(emptyCache(), EP, [{ id: 'glm-6' }], 7));
  assert.deepEqual(getEntry(readFreshnessCache(path), EP), { models: [{ id: 'glm-6' }], checkedAt: 7 });
});
