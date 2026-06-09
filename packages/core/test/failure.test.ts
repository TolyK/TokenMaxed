import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyHttpStatus, FAILURE_KINDS, isTransient, shouldCooldown } from '../src/failure.ts';

test('isTransient: capacity/timeout/5xx are transient; auth/bad-request/policy are permanent', () => {
  assert.equal(isTransient('timeout'), true);
  assert.equal(isTransient('rate_limited'), true);
  assert.equal(isTransient('quota_exhausted'), true);
  assert.equal(isTransient('provider_error'), true);
  assert.equal(isTransient('auth_failed'), false);
  assert.equal(isTransient('bad_request'), false);
  assert.equal(isTransient('policy_blocked'), false);
  // A worker give-back is permanent: retrying the same blind input cannot help.
  assert.equal(isTransient('insufficient_context'), false);
});

test('insufficient_context is a known kind and never triggers cooldown', () => {
  assert.ok(FAILURE_KINDS.includes('insufficient_context'));
  assert.equal(shouldCooldown('insufficient_context'), false);
});

test('every failure kind has a defined transient classification', () => {
  for (const k of FAILURE_KINDS) assert.equal(typeof isTransient(k), 'boolean');
});

test('shouldCooldown only for capacity/rate signals', () => {
  assert.equal(shouldCooldown('rate_limited'), true);
  assert.equal(shouldCooldown('quota_exhausted'), true);
  assert.equal(shouldCooldown('timeout'), false);
  assert.equal(shouldCooldown('provider_error'), false);
});

test('classifyHttpStatus maps the common provider signals', () => {
  assert.equal(classifyHttpStatus(408), 'timeout');
  assert.equal(classifyHttpStatus(504), 'timeout');
  assert.equal(classifyHttpStatus(429), 'rate_limited');
  assert.equal(classifyHttpStatus(402), 'quota_exhausted');
  assert.equal(classifyHttpStatus(401), 'auth_failed');
  assert.equal(classifyHttpStatus(403), 'auth_failed');
  assert.equal(classifyHttpStatus(400), 'bad_request');
  assert.equal(classifyHttpStatus(422), 'bad_request');
  assert.equal(classifyHttpStatus(500), 'provider_error');
  assert.equal(classifyHttpStatus(503), 'provider_error');
});
