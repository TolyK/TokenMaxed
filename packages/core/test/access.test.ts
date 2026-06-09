import assert from 'node:assert/strict';
import { test } from 'node:test';

import { INSUFFICIENT_CONTEXT_SENTINEL, inferAccessNeed, parseGiveBackSignal } from '../src/access.ts';

test('inferAccessNeed: explicit values are honored unchanged', () => {
  assert.equal(inferAccessNeed('worker-ok', 'anything'), 'worker-ok');
  assert.equal(inferAccessNeed('repo-tight', 'anything', ['a.ts']), 'repo-tight');
});

test('inferAccessNeed: auto and unset resolve to worker-ok (product decision)', () => {
  assert.equal(inferAccessNeed('auto', 'run the full test suite across the codebase', ['a.ts', 'b.ts']), 'worker-ok');
  assert.equal(inferAccessNeed(undefined, ''), 'worker-ok');
});

test('inferAccessNeed: an unexpected value is total — resolves to worker-ok', () => {
  assert.equal(inferAccessNeed('nonsense' as never, ''), 'worker-ok');
});

test('parseGiveBackSignal: detects the sentinel and extracts the need (original casing)', () => {
  const r = parseGiveBackSignal(`${INSUFFICIENT_CONTEXT_SENTINEL} need the Foo registry and the test runner`);
  assert.equal(r.insufficient, true);
  assert.equal(r.needed, 'need the Foo registry and the test runner');
});

test('parseGiveBackSignal: sentinel match is case-insensitive; leading/trailing space tolerated', () => {
  const r = parseGiveBackSignal('   insufficient_context:   db schema  ');
  assert.equal(r.insufficient, true);
  assert.equal(r.needed, 'db schema');
});

test('parseGiveBackSignal: sentinel with empty remainder ⇒ needed is empty string', () => {
  const r = parseGiveBackSignal(INSUFFICIENT_CONTEXT_SENTINEL);
  assert.equal(r.insufficient, true);
  assert.equal(r.needed, '');
});

test('parseGiveBackSignal: bounds the need to the first line, capped in length', () => {
  const multiline = parseGiveBackSignal(`${INSUFFICIENT_CONTEXT_SENTINEL} need the db schema\nand also a long rant\nplus more`);
  assert.equal(multiline.insufficient, true);
  assert.equal(multiline.needed, 'need the db schema'); // only the first line

  const huge = parseGiveBackSignal(`${INSUFFICIENT_CONTEXT_SENTINEL} ${'x'.repeat(500)}`);
  assert.equal(huge.insufficient, true);
  assert.equal(huge.needed!.length, 200); // capped
});

test('parseGiveBackSignal: normal output and empty text are not give-backs', () => {
  assert.deepEqual(parseGiveBackSignal('here is the function you asked for'), { insufficient: false });
  assert.deepEqual(parseGiveBackSignal('   '), { insufficient: false });
  // A sentinel that is not at the START is not a give-back.
  assert.deepEqual(parseGiveBackSignal(`done. ${INSUFFICIENT_CONTEXT_SENTINEL} x`), { insufficient: false });
});
