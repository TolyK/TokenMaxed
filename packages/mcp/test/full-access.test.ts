/**
 * Tests for the pure per-project "Reader -> Full-Access Grant" store.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFullAccess, grantFullAccess, revokeFullAccess } from '../src/full-access.ts';
import type { FullAccessStore } from '../src/full-access.ts';

/** In-memory store whose read() always reflects the latest write. */
function memStore(initial: Record<string, string[]> = {}): FullAccessStore {
  let state: Record<string, string[]> = { ...initial };
  return { read: () => state, write: (m) => { state = m; } };
}

test('readFullAccess returns [] when unset', () => {
  assert.deepEqual(readFullAccess(memStore(), 'p1'), []);
});

test('readFullAccess coerces corrupt/non-object or non-array to []', () => {
  const corrupt: FullAccessStore = { read: () => 'garbage', write: () => {} };
  assert.deepEqual(readFullAccess(corrupt, 'p1'), []);

  const nonArray: FullAccessStore = { read: () => ({ p1: 'stringNotArray' }), write: () => {} };
  assert.deepEqual(readFullAccess(nonArray, 'p1'), []);
});

test('grant round-trips correctly', () => {
  const store = memStore();
  grantFullAccess(store, 'p1', 'Minimax-api');
  assert.deepEqual(readFullAccess(store, 'p1'), ['Minimax-api']);
});

test('duplicate and different-casing grant does not duplicate (length 1, first casing kept)', () => {
  const store = memStore();
  grantFullAccess(store, 'p1', 'Minimax-api');
  grantFullAccess(store, 'p1', 'minimax-api');
  grantFullAccess(store, 'p1', 'MINIMAX-API');
  assert.deepEqual(readFullAccess(store, 'p1'), ['Minimax-api']);
});

test('grant preserves other projects and lane IDs', () => {
  const store = memStore();
  grantFullAccess(store, 'p1', 'minimax-api');
  grantFullAccess(store, 'p2', 'gemini-flash');
  grantFullAccess(store, 'p1', 'claude-haiku');

  assert.deepEqual(readFullAccess(store, 'p1'), ['minimax-api', 'claude-haiku']);
  assert.deepEqual(readFullAccess(store, 'p2'), ['gemini-flash']);
});

test('revoke(laneId) removes just that one (case-insensitive)', () => {
  const store = memStore();
  grantFullAccess(store, 'p1', 'minimax-api');
  grantFullAccess(store, 'p1', 'Gemini-flash');
  grantFullAccess(store, 'p1', 'claude-haiku');

  revokeFullAccess(store, 'p1', 'gemini-flash');
  assert.deepEqual(readFullAccess(store, 'p1'), ['minimax-api', 'claude-haiku']);
});

test('revoke() clears the project but leaves others', () => {
  const store = memStore();
  grantFullAccess(store, 'p1', 'minimax-api');
  grantFullAccess(store, 'p2', 'gemini-flash');

  revokeFullAccess(store, 'p1');
  assert.deepEqual(readFullAccess(store, 'p1'), []);
  assert.deepEqual(readFullAccess(store, 'p2'), ['gemini-flash']);
});

test('revoking the last lane ID deletes the entry (no empty arrays left)', () => {
  const store = memStore();
  grantFullAccess(store, 'p1', 'minimax-api');
  
  // Directly inspect underlying map to ensure entry was deleted
  let rawState: unknown = null;
  const storeWithInspect: FullAccessStore = {
    read: () => store.read(),
    write: (state) => {
      rawState = state;
      store.write(state);
    }
  };

  grantFullAccess(storeWithInspect, 'p1', 'minimax-api');
  revokeFullAccess(storeWithInspect, 'p1', 'minimax-api');

  assert.deepEqual(rawState, Object.create(null));
});

test('empty/whitespace grant is a no-op', () => {
  const store = memStore();
  grantFullAccess(store, 'p1', ' ');
  grantFullAccess(store, 'p1', '');
  assert.deepEqual(readFullAccess(store, 'p1'), []);
});
