import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TASK_CATEGORIES } from '../src/types.ts';
import {
  CODING_DOMAIN,
  TaxonomyError,
  activeCategories,
  domainOfCategory,
  isCanonical,
  isKnownCategory,
  registerDomain,
  toCanonical,
  toWire,
  unregisterDomain,
} from '../src/taxonomy.ts';

test('activeCategories deep-equals TASK_CATEGORIES with only coding registered', () => {
  assert.deepEqual(activeCategories(), [...TASK_CATEGORIES]);
});

test('toCanonical: wire→canonical, already-canonical, and unknown pass-through', () => {
  assert.equal(toCanonical('bugfix'), 'coding/bugfix');
  assert.equal(toCanonical('coding/bugfix'), 'coding/bugfix');
  assert.equal(toCanonical('totally-unknown'), 'totally-unknown');
});

test('toWire: canonical→wire, already-wire, and unknown pass-through', () => {
  assert.equal(toWire('coding/bugfix'), 'bugfix');
  assert.equal(toWire('bugfix'), 'bugfix');
  assert.equal(toWire('other/thing'), 'other/thing');
});

test('isKnownCategory: wire yes, canonical no, unknown no', () => {
  assert.equal(isKnownCategory('bugfix'), true);
  assert.equal(isKnownCategory('coding/bugfix'), false);
  assert.equal(isKnownCategory('nope'), false);
});

test('domainOfCategory: wire, canonical, and unknown', () => {
  assert.equal(domainOfCategory('bugfix'), 'coding');
  assert.equal(domainOfCategory('coding/bugfix'), 'coding');
  assert.equal(domainOfCategory('nope'), undefined);
});

test('round-trip: toWire(toCanonical(c)) === c for every TASK_CATEGORIES entry', () => {
  for (const c of TASK_CATEGORIES) {
    assert.equal(toWire(toCanonical(c)), c);
  }
});

test('registerDomain: collision throws TaxonomyError; re-register coding does not', () => {
  assert.throws(
    () => registerDomain({ domain: 'x', categories: ['bugfix'] }),
    (err: unknown) => err instanceof TaxonomyError,
  );
  // Idempotent replace of the same domain must not throw and must not leak state.
  registerDomain({ domain: CODING_DOMAIN, categories: [...TASK_CATEGORIES] });
  assert.deepEqual(activeCategories(), [...TASK_CATEGORIES]);
});

test('isCanonical edge cases', () => {
  assert.equal(isCanonical('/x'), false);
  assert.equal(isCanonical('x/'), false);
  assert.equal(isCanonical('a/b/c'), false);
  assert.equal(isCanonical(''), false);
  assert.equal(isCanonical('coding/bugfix'), true);
});

test('registerDomain validation throws TaxonomyError for bad domain/category ids', () => {
  assert.throws(
    () => registerDomain({ domain: '', categories: ['z'] }),
    (err: unknown) => err instanceof TaxonomyError,
  );
  assert.throws(
    () => registerDomain({ domain: 'a/b', categories: ['z'] }),
    (err: unknown) => err instanceof TaxonomyError,
  );
  assert.throws(
    () => registerDomain({ domain: 'tmp', categories: [''] }),
    (err: unknown) => err instanceof TaxonomyError,
  );
  assert.throws(
    () => registerDomain({ domain: 'tmp', categories: ['z/y'] }),
    (err: unknown) => err instanceof TaxonomyError,
  );
  assert.throws(
    () => registerDomain({ domain: 'tmp', categories: ['dup', 'dup'] }),
    (err: unknown) => err instanceof TaxonomyError,
  );
  // Failed validation must leave the coding-only registry intact.
  assert.deepEqual(activeCategories(), [...TASK_CATEGORIES]);
});

test('re-register drops released wire ids; unregisterDomain cleans up with no leak', () => {
  registerDomain({ domain: 'tmp', categories: ['tmpA', 'tmpB'] });
  assert.equal(isKnownCategory('tmpA'), true);
  assert.equal(isKnownCategory('tmpB'), true);

  registerDomain({ domain: 'tmp', categories: ['tmpA'] });
  assert.equal(isKnownCategory('tmpB'), false);
  assert.equal(domainOfCategory('tmpA'), 'tmp');

  unregisterDomain('tmp');
  assert.equal(isKnownCategory('tmpA'), false);
  assert.deepEqual(activeCategories(), [...TASK_CATEGORIES]);
});
