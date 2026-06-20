import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLASSIFY_FALLBACK_CATEGORY,
  MIN_CLASSIFY_CONFIDENCE,
  classifyTask,
} from '../src/classify.ts';

test('classifyTask: boilerplate clear case', () => {
  const result = classifyTask('Generate boilerplate config file skeleton.');
  // boilerplate score should be high
  assert.equal(result.category, 'boilerplate');
  assert.ok(result.confidence >= MIN_CLASSIFY_CONFIDENCE);
});

test('classifyTask: bugfix clear case', () => {
  const result = classifyTask('Fix crash error exception in production.');
  assert.equal(result.category, 'bugfix');
  assert.ok(result.confidence >= MIN_CLASSIFY_CONFIDENCE);
});

test('classifyTask: refactor clear case', () => {
  const result = classifyTask('Restructure clean up and deduplicate the helper file.');
  assert.equal(result.category, 'refactor');
  assert.ok(result.confidence >= MIN_CLASSIFY_CONFIDENCE);
});

test('classifyTask: explain clear case', () => {
  const result = classifyTask('Explain why how does the system behave.');
  assert.equal(result.category, 'explain');
  assert.ok(result.confidence >= MIN_CLASSIFY_CONFIDENCE);
});

test('classifyTask: feature clear case', () => {
  const result = classifyTask('Add support for new endpoint.');
  assert.equal(result.category, 'feature');
  assert.ok(result.confidence >= MIN_CLASSIFY_CONFIDENCE);
});

test('classifyTask: codegen clear case', () => {
  const result = classifyTask('Write a function and create a class.');
  assert.equal(result.category, 'codegen');
  assert.ok(result.confidence >= MIN_CLASSIFY_CONFIDENCE);
});

test('classifyTask: docs clear case', () => {
  const result = classifyTask('Document and write docs for readme documentation.');
  assert.equal(result.category, 'docs');
  assert.ok(result.confidence >= MIN_CLASSIFY_CONFIDENCE);
});

test('classifyTask: ambiguous/tied input has low confidence < MIN', () => {
  // 'fix' (bugfix, score 1) and 'documentation' (docs, score 1).
  const result = classifyTask('Fix documentation.');
  assert.ok(result.confidence < MIN_CLASSIFY_CONFIDENCE);
  // deterministic tie-break: bugfix comes before docs
  assert.equal(result.category, 'bugfix');
});

test('classifyTask: empty/garbage input returns fallback and confidence 0', () => {
  const resultEmpty = classifyTask('');
  assert.equal(resultEmpty.category, CLASSIFY_FALLBACK_CATEGORY);
  assert.equal(resultEmpty.confidence, 0);

  const resultGarbage = classifyTask('xyz abc qrs');
  assert.equal(resultGarbage.category, CLASSIFY_FALLBACK_CATEGORY);
  assert.equal(resultGarbage.confidence, 0);
});

test('classifyTask: unicode/garbage input returns fallback and confidence 0', () => {
  const result = classifyTask('🔥💀\u200b\u0000');
  assert.equal(result.category, CLASSIFY_FALLBACK_CATEGORY);
  assert.equal(result.confidence, 0);
});

test('classifyTask: bare move does not classify refactor work as refactor', () => {
  const result = classifyTask('move the feature flag to config');
  assert.notEqual(result.category, 'refactor');
  assert.ok(result.confidence < MIN_CLASSIFY_CONFIDENCE || result.category !== 'refactor');
});

test('classifyTask: bare comment does not classify feature work as docs', () => {
  const result = classifyTask('add a comment to the user');
  assert.notEqual(result.category, 'docs');
});

test('classifyTask: bare why/summarize does not classify debugging as explain', () => {
  const whyResult = classifyTask('why does this test fail');
  assert.notEqual(whyResult.category, 'explain');

  const summarizeResult = classifyTask('summarize the findings');
  assert.notEqual(summarizeResult.category, 'explain');
});

test('classifyTask: determinism', () => {
  const input = 'Add a new feature and fix a crash.';
  const r1 = classifyTask(input);
  const r2 = classifyTask(input);
  assert.deepEqual(r1, r2);
});

test('classifyTask: confidence is always in [0, 1]', () => {
  const inputs = [
    '',
    '   ',
    'hello world',
    'fix crash',
    'fix docs readme clean up config file generate why',
    'add a new feature',
  ];
  for (const input of inputs) {
    const res = classifyTask(input);
    assert.ok(res.confidence >= 0 && res.confidence <= 1);
  }
});
