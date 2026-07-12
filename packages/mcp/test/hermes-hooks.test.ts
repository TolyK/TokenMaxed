/**
 * F5 — Hermes hook logic: the pure gate matcher, the session-key/attempt
 * extraction, and the once-per-session banner marker (atomic-exclusive).
 * Entry modules are NOT imported (they read stdin at top level).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  HERMES_DELEGATE_TOOL,
  HERMES_MAX_VERIFY_NUDGES_DEFAULT,
  HERMES_VERIFY_BUDGET_MS,
  claimBannerMarker,
  hermesMaxRounds,
  hermesSessionKey,
  hermesVerifyAttempt,
  isHermesDelegateCall,
} from '../src/hermes-hooks.ts';
import { DIFF_ACQUISITION_HEADROOM_MS, reviewCliTimeoutFor } from '../src/host-review.ts';

test('isHermesDelegateCall: only the mcp_-prefixed delegate matches', () => {
  assert.equal(isHermesDelegateCall({ tool_name: HERMES_DELEGATE_TOOL }), true);
  assert.equal(isHermesDelegateCall({ tool_name: 'mcp_tokenmaxed_router_preview' }), false);
  assert.equal(isHermesDelegateCall({ tool_name: 'terminal' }), false);
  assert.equal(isHermesDelegateCall({}), false);
  assert.equal(isHermesDelegateCall({ tool_name: 42 as unknown as string }), false);
});

test('hermesSessionKey: sanitized + hash-disambiguated; default on absence', () => {
  assert.match(hermesSessionKey({ session_id: 'sess_abc123' }), /^sess_abc123-[0-9a-f]{8}$/);
  assert.match(hermesSessionKey({}), /^default-[0-9a-f]{8}$/);
  // Sanitization collisions ('a/b' vs 'a:b' both → 'a_b') stay DISTINCT keys.
  assert.notEqual(hermesSessionKey({ session_id: 'a/b' }), hermesSessionKey({ session_id: 'a:b' }));
  // …and the same raw id is stable.
  assert.equal(hermesSessionKey({ session_id: 'a/b' }), hermesSessionKey({ session_id: 'a/b' }));
});

test('hermesVerifyAttempt: strict non-negative integer; garbage ⇒ 0', () => {
  assert.equal(hermesVerifyAttempt({ extra: { attempt: 2 } }), 2);
  assert.equal(hermesVerifyAttempt({ extra: { attempt: 0 } }), 0);
  assert.equal(hermesVerifyAttempt({ extra: { attempt: -1 } }), 0);
  assert.equal(hermesVerifyAttempt({ extra: { attempt: 1.5 } }), 0);
  assert.equal(hermesVerifyAttempt({ extra: { attempt: '2' } }), 0);
  assert.equal(hermesVerifyAttempt({}), 0);
});

test('claimBannerMarker: exactly once per session key; other sessions independent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-hermes-marker-'));
  try {
    assert.equal(claimBannerMarker('s1', dir), true);
    assert.equal(claimBannerMarker('s1', dir), false); // claimed
    assert.equal(claimBannerMarker('s2', dir), true); // independent session
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claimBannerMarker: filesystem failure ⇒ false (skip, never repeat-banner)', () => {
  // A file path as the marker DIR makes mkdir/write fail.
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-hermes-marker-'));
  try {
    assert.equal(claimBannerMarker('s1', join(dir, 'not-a-dir-file')), true); // first creates fine
    // Now break it: point at a path UNDER an existing marker FILE.
    assert.equal(claimBannerMarker('x', join(dir, 'not-a-dir-file', 's1')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HERMES_VERIFY_BUDGET_MS leaves headroom under the 300s hook-timeout clamp', () => {
  assert.ok(HERMES_VERIFY_BUDGET_MS <= 300_000 - 20_000, 'review budget must leave hook spawn/IO headroom under the clamp');
});

test('hermesMaxRounds: capped at the HOST nudge limit so our yield state is reachable', () => {
  assert.equal(hermesMaxRounds({}), HERMES_MAX_VERIFY_NUDGES_DEFAULT); // TokenMaxed default (5) capped to 3
  assert.equal(hermesMaxRounds({ TOKENMAXED_REVIEW_MAX_ROUNDS: '1' }), 1); // a smaller explicit cap wins
  // Operator raised agent.max_verify_nudges and mirrored it ⇒ the cap follows.
  assert.equal(hermesMaxRounds({ TOKENMAXED_HERMES_VERIFY_NUDGES: '5' }), 5);
  assert.equal(hermesMaxRounds({ TOKENMAXED_HERMES_VERIFY_NUDGES: '5', TOKENMAXED_REVIEW_MAX_ROUNDS: '2' }), 2);
  assert.equal(hermesMaxRounds({ TOKENMAXED_HERMES_VERIFY_NUDGES: 'garbage' }), HERMES_MAX_VERIFY_NUDGES_DEFAULT);
});

test('reviewCliTimeoutFor: the CLI spawn timeout derives EXACTLY from the passed budget (the Hermes fix)', () => {
  // Pin the arithmetic, not just a range — a constant implementation must fail.
  assert.equal(reviewCliTimeoutFor(HERMES_VERIFY_BUDGET_MS), HERMES_VERIFY_BUDGET_MS - DIFF_ACQUISITION_HEADROOM_MS);
  assert.equal(reviewCliTimeoutFor(200_000), 200_000 - DIFF_ACQUISITION_HEADROOM_MS); // a second non-floor budget
  assert.equal(reviewCliTimeoutFor(10_000), 30_000); // floor clamps pathological budgets
  // …and diff acquisition + CLI provably fit the budget (the clamp-safety core).
  assert.ok(DIFF_ACQUISITION_HEADROOM_MS + reviewCliTimeoutFor(HERMES_VERIFY_BUDGET_MS) <= HERMES_VERIFY_BUDGET_MS);
  assert.ok(HERMES_VERIFY_BUDGET_MS <= 300_000 - 30_000, 'bounded out-of-budget steps (probe/config/IO) need real slack under the clamp');
});
