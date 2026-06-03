/**
 * A-6 tests — the pure PreToolUse decision. Allow ⇒ null; disabled ⇒ deny payload
 * in the exact shape Claude Code expects.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PRETOOLUSE_DENY_REASON, preToolUseDecision } from '../src/hook.ts';

test('allows the delegate call when routing is enabled', () => {
  assert.equal(preToolUseDecision(true), null);
});

test('denies the delegate call when routing is disabled', () => {
  const d = preToolUseDecision(false);
  assert.ok(d);
  assert.equal(d!.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(d!.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(d!.hookSpecificOutput.permissionDecisionReason, PRETOOLUSE_DENY_REASON);
});
