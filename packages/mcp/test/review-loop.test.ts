/**
 * REVIEW-LOOP tests — the pure decision logic for the default-ON review-iterate
 * gate: the enable switch (default-on + opt-out + kill-switch), the bounded
 * round count, and stopHookAction's terminal states (the three protections).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_REVIEW_MAX_ROUNDS,
  parseMaxRounds,
  reviewLoopEnabled,
  stopHookAction,
} from '../src/reviewer.ts';

// --- reviewLoopEnabled: default-ON, explicit opt-out, global kill-switch ------

test('reviewLoopEnabled defaults ON when nothing is set', () => {
  assert.equal(reviewLoopEnabled({}), true);
});

test('reviewLoopEnabled stays on for the legacy explicit-true (no breakage)', () => {
  assert.equal(reviewLoopEnabled({ TOKENMAXED_REVIEW_ON_STOP: 'true' }), true);
});

test('reviewLoopEnabled opts out on false/0/off/no (any case)', () => {
  for (const v of ['false', 'FALSE', '0', 'off', 'No', ' false ']) {
    assert.equal(reviewLoopEnabled({ TOKENMAXED_REVIEW_ON_STOP: v }), false, `"${v}" should opt out`);
  }
});

test('reviewLoopEnabled is off under the global kill-switch even if not opted out', () => {
  assert.equal(reviewLoopEnabled({ TOKENMAXED_DISABLE: '1' }), false);
  assert.equal(reviewLoopEnabled({ TOKENMAXED_DISABLE: 'true' }), false);
});

// --- parseMaxRounds: default + clamp ------------------------------------------

test('parseMaxRounds defaults when unset or invalid', () => {
  assert.equal(parseMaxRounds({}), DEFAULT_REVIEW_MAX_ROUNDS);
  assert.equal(parseMaxRounds({ TOKENMAXED_REVIEW_MAX_ROUNDS: 'abc' }), DEFAULT_REVIEW_MAX_ROUNDS);
  assert.equal(parseMaxRounds({ TOKENMAXED_REVIEW_MAX_ROUNDS: '0' }), DEFAULT_REVIEW_MAX_ROUNDS);
  assert.equal(parseMaxRounds({ TOKENMAXED_REVIEW_MAX_ROUNDS: '-3' }), DEFAULT_REVIEW_MAX_ROUNDS);
});

test('parseMaxRounds honors a valid value and clamps to the cap', () => {
  assert.equal(parseMaxRounds({ TOKENMAXED_REVIEW_MAX_ROUNDS: '3' }), 3);
  assert.equal(parseMaxRounds({ TOKENMAXED_REVIEW_MAX_ROUNDS: '999' }), 20);
});

// --- stopHookAction: terminal states + the three protections ------------------

test('pass ⇒ allow (silent success)', () => {
  assert.deepEqual(stopHookAction({ reviewed: true, verdict: 'pass', priorBlocks: 0, maxRounds: 5 }), {
    kind: 'allow',
  });
});

test('no changes / no reviewer ⇒ allow (silent skip = opt-out-by-absence)', () => {
  // reviewed:false WITHOUT errored is the benign "nothing to review / no manager" case.
  assert.deepEqual(stopHookAction({ reviewed: false, priorBlocks: 0, maxRounds: 5 }), { kind: 'allow' });
});

test('Protection A — reviewer error ⇒ notify, NEVER a silent pass', () => {
  const a = stopHookAction({ reviewed: false, errored: true, reason: 'review timed out', priorBlocks: 0, maxRounds: 5 });
  assert.equal(a.kind, 'notify');
  assert.match((a as { message: string }).message, /could not run/);
  assert.match((a as { message: string }).message, /timed out/);
  assert.match((a as { message: string }).message, /NOT reviewed/);
});

test('non-pass within the budget ⇒ block with the notes fed back (iterate)', () => {
  const a = stopHookAction({
    reviewed: true,
    verdict: 'needs-rework',
    notes: 'fix the off-by-one',
    managerLaneId: 'codex',
    priorBlocks: 0,
    maxRounds: 5,
  });
  assert.equal(a.kind, 'block');
  assert.match((a as { reason: string }).reason, /codex/);
  assert.match((a as { reason: string }).reason, /needs-rework/);
  assert.match((a as { reason: string }).reason, /fix the off-by-one/);
});

test('iterates across rounds — still blocks at the last round before the bound', () => {
  // maxRounds=5 ⇒ blocks while priorBlocks < 5 (rounds 0..4), regardless of verdict flavor.
  for (let pb = 0; pb < 5; pb++) {
    assert.equal(stopHookAction({ reviewed: true, verdict: 'fail', priorBlocks: pb, maxRounds: 5 }).kind, 'block', `round ${pb}`);
  }
});

test('Protection B — at maxRounds without a pass ⇒ notify + yield (never stuck), with notes', () => {
  const a = stopHookAction({
    reviewed: true,
    verdict: 'needs-rework',
    notes: 'still some nits',
    priorBlocks: 5,
    maxRounds: 5,
  });
  assert.equal(a.kind, 'notify');
  assert.match((a as { message: string }).message, /after 5 rework round\(s\)/);
  assert.match((a as { message: string }).message, /yielding/);
  assert.match((a as { message: string }).message, /still some nits/);
  assert.match((a as { message: string }).message, /TOKENMAXED_REVIEW_MAX_ROUNDS/);
});

test('long notes are truncated in surfaced/blocked messages', () => {
  const big = 'x'.repeat(5000);
  const block = stopHookAction({ reviewed: true, verdict: 'fail', notes: big, priorBlocks: 0, maxRounds: 5 });
  assert.match((block as { reason: string }).reason, /\[notes truncated\]/);
});
