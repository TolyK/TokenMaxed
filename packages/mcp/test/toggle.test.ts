/**
 * A-4 tests — the pure project-keyed toggle, with an in-memory store (no I/O).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readEnabled, writeEnabled } from '../src/toggle.ts';
import type { ToggleStore } from '../src/toggle.ts';

function memStore(initial: unknown = undefined): ToggleStore & { state: Record<string, boolean> | undefined } {
  let state = initial as Record<string, boolean> | undefined;
  return {
    state: state as Record<string, boolean> | undefined,
    read: () => state,
    write: (s) => {
      state = s;
    },
  };
}

test('defaults to enabled when the project has no stored entry', () => {
  assert.equal(readEnabled(memStore(), '/proj/a'), true);
  assert.equal(readEnabled(memStore({}), '/proj/a'), true);
});

test('reads back a persisted disabled state', () => {
  const store = memStore();
  writeEnabled(store, '/proj/a', false);
  assert.equal(readEnabled(store, '/proj/a'), false);
});

test('toggling one project never affects another', () => {
  const store = memStore();
  writeEnabled(store, '/proj/a', false);
  writeEnabled(store, '/proj/b', true);
  assert.equal(readEnabled(store, '/proj/a'), false);
  assert.equal(readEnabled(store, '/proj/b'), true);
  assert.equal(readEnabled(store, '/proj/c'), true); // untouched ⇒ default
});

test('ignores a corrupt/non-object store (treats as empty ⇒ default enabled)', () => {
  assert.equal(readEnabled(memStore('garbage'), '/proj/a'), true);
  assert.equal(readEnabled(memStore([1, 2, 3]), '/proj/a'), true);
});
