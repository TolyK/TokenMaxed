/**
 * YOLO tests — the pure project-keyed YOLO toggle, with an in-memory store (no I/O).
 * Mirrors toggle.test.ts. Key difference: YOLO is OFF by default, with a caller-
 * supplied env fallback that a stored per-project value always overrides.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readYolo, writeYolo } from '../src/yolo.ts';
import type { YoloStore } from '../src/yolo.ts';

function memStore(initial: unknown = undefined): YoloStore {
  let state = initial as Record<string, boolean> | undefined;
  return {
    read: () => state,
    write: (s) => {
      state = s;
    },
  };
}

test('defaults to OFF when the project has no stored entry and no fallback', () => {
  assert.equal(readYolo(memStore(), '/proj/a'), false);
  assert.equal(readYolo(memStore({}), '/proj/a'), false);
});

test('uses the env fallback when the project has no stored entry', () => {
  assert.equal(readYolo(memStore(), '/proj/a', true), true);
  assert.equal(readYolo(memStore(), '/proj/a', false), false);
});

test('a stored per-project value overrides the env fallback (both directions)', () => {
  const on = memStore();
  writeYolo(on, '/proj/a', true);
  assert.equal(readYolo(on, '/proj/a', false), true); // stored ON beats fallback OFF

  const off = memStore();
  writeYolo(off, '/proj/a', false);
  assert.equal(readYolo(off, '/proj/a', true), false); // stored OFF beats fallback ON
});

test('toggling one project never affects another', () => {
  const store = memStore();
  writeYolo(store, '/proj/a', true);
  writeYolo(store, '/proj/b', false);
  assert.equal(readYolo(store, '/proj/a'), true);
  assert.equal(readYolo(store, '/proj/b'), false);
  assert.equal(readYolo(store, '/proj/c'), false); // untouched ⇒ default OFF
  assert.equal(readYolo(store, '/proj/c', true), true); // untouched ⇒ fallback wins
});

test('ignores a corrupt/non-object store (treats as empty ⇒ fallback decides)', () => {
  assert.equal(readYolo(memStore('garbage'), '/proj/a'), false);
  assert.equal(readYolo(memStore([1, 2, 3]), '/proj/a', true), true);
});
