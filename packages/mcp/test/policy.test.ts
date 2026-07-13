/**
 * Tests for the pure per-project "named routing policy" store.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readPolicy, writePolicy, isValidRoutingPolicy } from '../src/routing-policy.ts';
import type { PolicyStore, NamedRoutingPolicy } from '../src/routing-policy.ts';

function memStore(initial: Record<string, NamedRoutingPolicy> = {}): PolicyStore {
  let state: Record<string, NamedRoutingPolicy> = { ...initial };
  return { read: () => state, write: (m) => { state = m; } };
}

test('readPolicy returns undefined when unset', () => {
  assert.equal(readPolicy(memStore(), 'p1'), undefined);
});

test('writePolicy then readPolicy round-trips a valid policy', () => {
  const store = memStore();
  writePolicy(store, 'p1', 'preserve-frontier');
  assert.equal(readPolicy(store, 'p1'), 'preserve-frontier');
});

test('writePolicy(undefined) clears the policy', () => {
  const store = memStore();
  writePolicy(store, 'p1', 'preserve-frontier');
  writePolicy(store, 'p1', undefined);
  assert.equal(readPolicy(store, 'p1'), undefined);
});

test('off, clear, none clear the policy store entry, balanced persists', () => {
  const store = memStore();
  writePolicy(store, 'p1', 'preserve-frontier');
  writePolicy(store, 'p1', 'off');
  assert.equal(readPolicy(store, 'p1'), undefined);

  writePolicy(store, 'p1', 'reliable');
  writePolicy(store, 'p1', 'clear');
  assert.equal(readPolicy(store, 'p1'), undefined);

  writePolicy(store, 'p1', 'reliable');
  writePolicy(store, 'p1', 'none');
  assert.equal(readPolicy(store, 'p1'), undefined);

  writePolicy(store, 'p1', 'reliable');
  writePolicy(store, 'p1', 'balanced');
  assert.equal(readPolicy(store, 'p1'), 'balanced');
});

test('policies are isolated per project', () => {
  const store = memStore();
  writePolicy(store, 'p1', 'preserve-frontier');
  writePolicy(store, 'p2', 'reliable');
  writePolicy(store, 'p1', undefined);
  assert.equal(readPolicy(store, 'p1'), undefined);
  assert.equal(readPolicy(store, 'p2'), 'reliable');
});

test('unknown policy stored values are dropped', () => {
  const garbage: PolicyStore = { read: () => ({ p1: 'garbage-policy' }), write: () => {} };
  assert.equal(readPolicy(garbage, 'p1'), undefined);
});

test('isValidRoutingPolicy validation helper', () => {
  assert.equal(isValidRoutingPolicy('balanced'), true);
  assert.equal(isValidRoutingPolicy('cheapest'), true);
  assert.equal(isValidRoutingPolicy('preserve-frontier'), true);
  assert.equal(isValidRoutingPolicy('reliable'), true);
  assert.equal(isValidRoutingPolicy('garbage'), false);
  assert.equal(isValidRoutingPolicy(''), false);
});
