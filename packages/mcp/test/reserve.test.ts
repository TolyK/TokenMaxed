/**
 * Tests for the pure per-project capacity reservation store overrides.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readReserves, writeReserve } from '../src/reserve.ts';
import type { ReserveStore } from '../src/reserve.ts';

function memStore(initial: Record<string, Record<string, number>> = {}): ReserveStore {
  let state: Record<string, Record<string, number>> = { ...initial };
  return { read: () => state, write: (m) => { state = m; } };
}

test('readReserves returns empty object when unset', () => {
  assert.deepEqual(readReserves(memStore(), 'p1'), {});
});

test('writeReserve then readReserves round-trips a reservation fraction', () => {
  const store = memStore();
  writeReserve(store, 'p1', 'opus', 0.15);
  assert.deepEqual(readReserves(store, 'p1'), { opus: 0.15 });
});

test('writeReserve(undefined) clears the override for that key', () => {
  const store = memStore();
  writeReserve(store, 'p1', 'opus', 0.15);
  writeReserve(store, 'p1', 'opus', undefined);
  assert.deepEqual(readReserves(store, 'p1'), {});
});

test('writeReserve with key as undefined clears all reservations for the project', () => {
  const store = memStore();
  writeReserve(store, 'p1', 'opus', 0.15);
  writeReserve(store, 'p1', 'sonnet', 0.20);
  writeReserve(store, 'p1', undefined, undefined);
  assert.deepEqual(readReserves(store, 'p1'), {});
});

test('reservations are isolated per project', () => {
  const store = memStore();
  writeReserve(store, 'p1', 'opus', 0.15);
  writeReserve(store, 'p2', 'sonnet', 0.10);
  assert.deepEqual(readReserves(store, 'p1'), { opus: 0.15 });
  assert.deepEqual(readReserves(store, 'p2'), { sonnet: 0.10 });
});

test('garbage values are coerced', () => {
  const garbage: ReserveStore = { read: () => ({ p1: { opus: 'garbage' } }), write: () => {} };
  assert.deepEqual(readReserves(garbage, 'p1'), {});
});
