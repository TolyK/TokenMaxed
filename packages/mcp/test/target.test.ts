/**
 * Tests for the pure per-project target datetime overrides.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readTargets, writeTarget } from '../src/target.ts';
import type { TargetStore } from '../src/target.ts';

function memStore(initial: Record<string, Record<string, string>> = {}): TargetStore {
  let state: Record<string, Record<string, string>> = { ...initial };
  return { read: () => state, write: (m) => { state = m; } };
}

test('readTargets returns empty object when unset', () => {
  assert.deepEqual(readTargets(memStore(), 'p1'), {});
});

test('writeTarget then readTargets round-trips a future ISO datetime', () => {
  const store = memStore();
  const futureStr = new Date(Date.now() + 3600000).toISOString();
  writeTarget(store, 'p1', 'opus', futureStr);
  assert.deepEqual(readTargets(store, 'p1'), { opus: futureStr });
});

test('writeTarget with past target clears it', () => {
  const store = memStore();
  const pastStr = new Date(Date.now() - 3600000).toISOString();
  writeTarget(store, 'p1', 'opus', pastStr);
  assert.deepEqual(readTargets(store, 'p1'), {});
});

test('writeTarget(undefined) clears the override for that key', () => {
  const store = memStore();
  const futureStr = new Date(Date.now() + 3600000).toISOString();
  writeTarget(store, 'p1', 'opus', futureStr);
  writeTarget(store, 'p1', 'opus', undefined);
  assert.deepEqual(readTargets(store, 'p1'), {});
});

test('writeTarget with key as undefined clears all targets for the project', () => {
  const store = memStore();
  const futureStr = new Date(Date.now() + 3600000).toISOString();
  writeTarget(store, 'p1', 'opus', futureStr);
  writeTarget(store, 'p1', 'sonnet', futureStr);
  writeTarget(store, 'p1', undefined, undefined);
  assert.deepEqual(readTargets(store, 'p1'), {});
});

test('targets are isolated per project', () => {
  const store = memStore();
  const futureStr = new Date(Date.now() + 3600000).toISOString();
  writeTarget(store, 'p1', 'opus', futureStr);
  writeTarget(store, 'p2', 'sonnet', futureStr);
  assert.deepEqual(readTargets(store, 'p1'), { opus: futureStr });
  assert.deepEqual(readTargets(store, 'p2'), { sonnet: futureStr });
});

test('garbage/unparseable values are coerced/dropped', () => {
  const garbage: TargetStore = { read: () => ({ p1: { opus: 'garbage-date' } }), write: () => {} };
  assert.deepEqual(readTargets(garbage, 'p1'), {});
});
