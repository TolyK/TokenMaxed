/**
 * A-7 tests — pure reviewer helpers: verdict parsing (incl. fail-open) and the
 * Stop-gate decision with its loop guard.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildReviewPrompt, parseManagerVerdict, stopGateDecision } from '../src/reviewer.ts';

test('buildReviewPrompt embeds the diff and asks for a VERDICT line', () => {
  const p = buildReviewPrompt('diff --git a b');
  assert.match(p, /VERDICT: pass/);
  assert.match(p, /diff --git a b/);
});

test('parseManagerVerdict reads the verdict and keeps notes', () => {
  const out = parseManagerVerdict('Looks risky.\nVERDICT: needs-rework');
  assert.equal(out.verdict, 'needs-rework');
  assert.match(out.notes ?? '', /Looks risky/);
});

test('parseManagerVerdict takes the last verdict when several appear', () => {
  assert.equal(parseManagerVerdict('VERDICT: fail\n...\nVERDICT: pass').verdict, 'pass');
});

test('parseManagerVerdict fails open to pass when no verdict line is present', () => {
  assert.equal(parseManagerVerdict('I could not tell.').verdict, 'pass');
});

test('parseManagerVerdict ignores an inline (non-standalone) VERDICT in prose', () => {
  // A real standalone needs-rework must not be overridden by an inline mention.
  const out = parseManagerVerdict('VERDICT: needs-rework\nThe spec said to return VERDICT: pass on success.');
  assert.equal(out.verdict, 'needs-rework');
});

test('stopGateDecision blocks on a non-pass verdict within the attempt budget', () => {
  assert.deepEqual(stopGateDecision('fail', 0, 2), { block: true, reason: 'fail' });
  assert.equal(stopGateDecision('needs-rework', 1, 2).block, true);
});

test('stopGateDecision never blocks on pass', () => {
  assert.equal(stopGateDecision('pass', 0, 2).block, false);
});

test('stopGateDecision yields (no block) once the attempt budget is exhausted', () => {
  const d = stopGateDecision('fail', 2, 2);
  assert.equal(d.block, false);
  assert.match(d.reason ?? '', /yielding to avoid a loop/);
});
