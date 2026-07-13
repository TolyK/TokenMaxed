/**
 * Tests for the pure per-project routed-share store overrides.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readRoutedShares, writeRoutedShare } from '../src/routed-share.ts';
import type { RoutedShareStore } from '../src/routed-share.ts';

function memStore(initial: Record<string, Record<string, number>> = {}): RoutedShareStore {
  let state: Record<string, Record<string, number>> = { ...initial };
  return { read: () => state, write: (m) => { state = m; } };
}

test('readRoutedShares returns empty object when unset', () => {
  assert.deepEqual(readRoutedShares(memStore(), 'p1'), {});
});

test('writeRoutedShare then readRoutedShares round-trips a routed-share fraction', () => {
  const store = memStore();
  writeRoutedShare(store, 'p1', 'opus', 0.15);
  assert.deepEqual(readRoutedShares(store, 'p1'), { opus: 0.15 });
});

test('writeRoutedShare(undefined) clears the override for that key', () => {
  const store = memStore();
  writeRoutedShare(store, 'p1', 'opus', 0.15);
  writeRoutedShare(store, 'p1', 'opus', undefined);
  assert.deepEqual(readRoutedShares(store, 'p1'), {});
});

test('writeRoutedShare with key as undefined clears all routed shares for the project', () => {
  const store = memStore();
  writeRoutedShare(store, 'p1', 'opus', 0.15);
  writeRoutedShare(store, 'p1', 'sonnet', 0.20);
  writeRoutedShare(store, 'p1', undefined, undefined);
  assert.deepEqual(readRoutedShares(store, 'p1'), {});
});

test('routed shares are isolated per project', () => {
  const store = memStore();
  writeRoutedShare(store, 'p1', 'opus', 0.15);
  writeRoutedShare(store, 'p2', 'sonnet', 0.10);
  assert.deepEqual(readRoutedShares(store, 'p1'), { opus: 0.15 });
  assert.deepEqual(readRoutedShares(store, 'p2'), { sonnet: 0.10 });
});

test('routed share validation: drops <= 0, > 1, and non-finite', () => {
  const store = memStore();
  // Valid bounds: (0, 1]
  writeRoutedShare(store, 'p1', 'zero', 0); // should be dropped
  writeRoutedShare(store, 'p1', 'negative', -0.5); // should be dropped
  writeRoutedShare(store, 'p1', 'greaterThanOne', 1.01); // should be dropped
  writeRoutedShare(store, 'p1', 'one', 1); // should be kept
  writeRoutedShare(store, 'p1', 'half', 0.5); // should be kept
  writeRoutedShare(store, 'p1', 'nan', NaN); // should be dropped
  writeRoutedShare(store, 'p1', 'inf', Infinity); // should be dropped

  assert.deepEqual(readRoutedShares(store, 'p1'), { one: 1, half: 0.5 });
});

test('readRoutedShares drops junk already present in the initial state of the store', () => {
  const initialData = {
    p1: {
      zero: 0,
      negative: -0.5,
      greaterThanOne: 1.01,
      one: 1,
      half: 0.5,
      nan: NaN,
      inf: Infinity,
      junkType: 'hello' as any,
    }
  };
  const store = memStore(initialData);
  assert.deepEqual(readRoutedShares(store, 'p1'), { one: 1, half: 0.5 });
});
