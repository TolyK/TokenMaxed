/**
 * Tests for the pure per-project "preferred lane" store (universal offload override).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readPreferred, writePreferred } from '../src/prefer.ts';
import type { PreferStore } from '../src/prefer.ts';

/** In-memory store whose read() always reflects the latest write (closure-backed). */
function memStore(initial: Record<string, string> = {}): PreferStore {
  let state: Record<string, string> = { ...initial };
  return { read: () => state, write: (m) => { state = m; } };
}

test('readPreferred returns undefined when unset', () => {
  assert.equal(readPreferred(memStore(), 'p1'), undefined);
});

test('writePreferred then readPreferred round-trips a lane id', () => {
  const store = memStore();
  writePreferred(store, 'p1', 'minimax-api');
  assert.equal(readPreferred(store, 'p1'), 'minimax-api');
});

test('writePreferred(undefined) clears the preference', () => {
  const store = memStore();
  writePreferred(store, 'p1', 'minimax-api');
  writePreferred(store, 'p1', undefined);
  assert.equal(readPreferred(store, 'p1'), undefined);
});

test('empty-string laneId clears too', () => {
  const store = memStore();
  writePreferred(store, 'p1', 'minimax-api');
  writePreferred(store, 'p1', '');
  assert.equal(readPreferred(store, 'p1'), undefined);
});

test('preferences are isolated per project', () => {
  const store = memStore();
  writePreferred(store, 'p1', 'a');
  writePreferred(store, 'p2', 'b');
  writePreferred(store, 'p1', undefined);
  assert.equal(readPreferred(store, 'p1'), undefined);
  assert.equal(readPreferred(store, 'p2'), 'b');
});

test('coerces a non-string/garbage stored value to no-preference', () => {
  const garbage: PreferStore = { read: () => ({ p1: 123 }), write: () => {} };
  assert.equal(readPreferred(garbage, 'p1'), undefined);
});
