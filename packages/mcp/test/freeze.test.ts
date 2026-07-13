/**
 * tests for the project-keyed learning-frozen toggle, with an in-memory store (no I/O).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFrozen, writeFrozen } from '../src/freeze.ts';
import type { FreezeStore } from '../src/freeze.ts';

function memStore(initial: unknown = undefined): FreezeStore & { state: Record<string, boolean> | undefined } {
  let state = initial as Record<string, boolean> | undefined;
  return {
    state: state as Record<string, boolean> | undefined,
    read: () => state,
    write: (s) => {
      state = s;
    },
  };
}

test('defaults to false (not frozen) when the project has no stored entry', () => {
  assert.equal(readFrozen(memStore(), '/proj/a'), false);
  assert.equal(readFrozen(memStore({}), '/proj/a'), false);
});

test('reads back a persisted frozen state', () => {
  const store = memStore();
  writeFrozen(store, '/proj/a', true);
  assert.equal(readFrozen(store, '/proj/a'), true);
});

test('freezing one project never affects another', () => {
  const store = memStore();
  writeFrozen(store, '/proj/a', true);
  writeFrozen(store, '/proj/b', false);
  assert.equal(readFrozen(store, '/proj/a'), true);
  assert.equal(readFrozen(store, '/proj/b'), false);
  assert.equal(readFrozen(store, '/proj/c'), false); // untouched ⇒ default
});

test('ignores a corrupt/non-object store (treats as empty ⇒ default false)', () => {
  assert.equal(readFrozen(memStore('garbage'), '/proj/a'), false);
  assert.equal(readFrozen(memStore([1, 2, 3]), '/proj/a'), false);
});
