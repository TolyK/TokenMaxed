import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FIVE_HOUR_MS,
  msUntilWindowFrees,
  requestsInWindow,
  windowHeadroom,
  windowLevel,
  windowUsedFraction,
  WINDOW_CRITICAL_USED,
  WINDOW_WARN_USED,
} from '../src/window-quota.ts';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

test('requestsInWindow: empty => 0; boundary excludes cutoff, includes now', () => {
  assert.equal(requestsInWindow([], NOW), 0);
  const atCutoff = NOW - FIVE_HOUR_MS;
  const atNow = NOW;
  assert.equal(requestsInWindow([atCutoff], NOW), 0);
  assert.equal(requestsInWindow([atNow], NOW), 1);
  assert.equal(requestsInWindow([atCutoff, atNow], NOW), 1);
});

test('requestsInWindow: future timestamps excluded', () => {
  assert.equal(requestsInWindow([NOW + 1, NOW + HOUR], NOW), 0);
  assert.equal(requestsInWindow([NOW - HOUR, NOW + 1], NOW), 1);
});

test('requestsInWindow: custom windowMs and invalid windowMs fallback', () => {
  const twoHours = 2 * HOUR;
  const ts = [NOW - 3 * HOUR, NOW - HOUR, NOW];
  assert.equal(requestsInWindow(ts, NOW, twoHours), 2); // 3h ago out, 1h ago + now in
  assert.equal(requestsInWindow(ts, NOW, 0), 3); // <=0 => FIVE_HOUR_MS, all three in
  assert.equal(requestsInWindow(ts, NOW, -100), 3);
  assert.equal(requestsInWindow(ts, NOW, NaN), 3);
  assert.equal(requestsInWindow(ts, NOW, Infinity), 3);
});

test('requestsInWindow: NaN/Infinity timestamps ignored', () => {
  assert.equal(requestsInWindow([NaN, Infinity, -Infinity, NOW - HOUR], NOW), 1);
});

test('windowUsedFraction and windowHeadroom: zero limit, partial, at, over', () => {
  assert.equal(windowUsedFraction(5, 0), 0);
  assert.equal(windowHeadroom(5, 0), 1);
  assert.equal(windowUsedFraction(3, 10), 0.3);
  assert.ok(Math.abs(windowHeadroom(3, 10) - 0.7) < 1e-9);
  assert.equal(windowUsedFraction(10, 10), 1);
  assert.equal(windowHeadroom(10, 10), 0);
  assert.equal(windowUsedFraction(15, 10), 1.5);
  assert.equal(windowHeadroom(15, 10), 0);
  // Non-finite / negative count treated as 0.
  assert.equal(windowUsedFraction(NaN, 10), 0);
  assert.equal(windowUsedFraction(-5, 10), 0);
  assert.equal(windowHeadroom(-5, 10), 1);
  // Non-finite limit treated as no limit.
  assert.equal(windowUsedFraction(5, NaN), 0);
  assert.equal(windowUsedFraction(5, Infinity), 0);
  assert.equal(windowHeadroom(5, NaN), 1);
  assert.equal(windowHeadroom(5, Infinity), 1);
});

test('windowLevel classifies ok / warn / critical at the thresholds', () => {
  assert.equal(windowLevel(0.5), 'ok');
  assert.equal(windowLevel(WINDOW_WARN_USED - 0.01), 'ok');
  assert.equal(windowLevel(WINDOW_WARN_USED), 'warn');
  assert.equal(windowLevel(WINDOW_CRITICAL_USED - 0.01), 'warn');
  assert.equal(windowLevel(WINDOW_CRITICAL_USED), 'critical');
  assert.equal(windowLevel(1.5), 'critical');
});

test('msUntilWindowFrees: no in-window => 0; picks oldest; never negative', () => {
  assert.equal(msUntilWindowFrees([], NOW), 0);
  const oldest = NOW - 4 * HOUR;
  const newer = NOW - HOUR;
  const ts = [newer, oldest, NOW - 2 * HOUR];
  const expected = Math.floor(oldest + FIVE_HOUR_MS - NOW);
  assert.equal(msUntilWindowFrees(ts, NOW), expected);
  assert.ok(msUntilWindowFrees(ts, NOW) >= 0);
  // All expired => 0
  assert.equal(msUntilWindowFrees([NOW - 6 * HOUR], NOW), 0);
});