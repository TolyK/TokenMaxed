/**
 * Unit tests for runReviewWithBudget (review-budget.ts).
 * These tests use short totalBudgetMs values (200–400 ms) so they run quickly.
 * Tests that need a "slow runner" use a ref'd setTimeout so Node does not exit early;
 * each test cancels its runner timer in an afterEach/finally so no lingering handles
 * leak into subsequent tests.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runReviewWithBudget } from '../src/review-budget.ts';
import type { HostReviewResult } from '../src/host-review.ts';

let idCounter = 0;
const nextId = () => `turn-${++idCounter}`;

const PASS: HostReviewResult = { reviewed: true, verdict: 'pass' };

test('runReviewWithBudget — fast passing runner: returned immediately', async () => {
  const runner = async (_turnId: string) => PASS;
  const result = await runReviewWithBudget(runner, nextId, { totalBudgetMs: 300, maxRetries: 0 });
  assert.deepEqual(result, PASS);
});

test('runReviewWithBudget — slow runner times out, fails open with reviewed:false', async () => {
  // Runner that takes longer than the slot.
  let cancelRunner: (() => void) | undefined;
  const runner = (_turnId: string): Promise<HostReviewResult> =>
    new Promise((resolve) => {
      // Use a ref'd timer so it would keep Node alive — we cancel it in finally.
      const t = setTimeout(() => resolve(PASS), 2_000);
      cancelRunner = () => clearTimeout(t);
    });

  try {
    const result = await runReviewWithBudget(runner, nextId, {
      totalBudgetMs: 200,
      maxRetries: 0, // one attempt only
    });
    assert.equal(result.reviewed, false, 'should fail open on timeout');
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0, 'should have a reason');
  } finally {
    cancelRunner?.();
  }
});

test('runReviewWithBudget — runner throws on first attempt, succeeds on second', async () => {
  let calls = 0;
  const runner = async (_turnId: string): Promise<HostReviewResult> => {
    calls += 1;
    if (calls === 1) throw new Error('transient error');
    return PASS;
  };
  // totalBudgetMs=400, maxRetries=1 → two 200 ms slots.
  const result = await runReviewWithBudget(runner, nextId, { totalBudgetMs: 400, maxRetries: 1 });
  assert.deepEqual(result, PASS);
  assert.equal(calls, 2);
});

test('runReviewWithBudget — maxRetries:0 + slow runner: no retry, fails open', async () => {
  let calls = 0;
  let cancelRunner: (() => void) | undefined;
  const runner = (_turnId: string): Promise<HostReviewResult> => {
    calls += 1;
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(PASS), 2_000);
      cancelRunner = () => clearTimeout(t);
    });
  };

  try {
    const result = await runReviewWithBudget(runner, nextId, {
      totalBudgetMs: 200,
      maxRetries: 0,
    });
    assert.equal(result.reviewed, false);
    assert.equal(calls, 1, 'only one attempt with maxRetries:0');
  } finally {
    cancelRunner?.();
  }
});

test('runReviewWithBudget — budget too small returns immediately with reason', async () => {
  // perAttemptMs = floor(50 / 3) = 16 ms → too small to be meaningful but > 0 so not caught
  // Actually floor(10/2) = 5 — still > 0. Use 0ms total.
  const result = await runReviewWithBudget(async () => PASS, nextId, {
    totalBudgetMs: 0,
    maxRetries: 1,
  });
  assert.equal(result.reviewed, false);
  assert.match(result.reason ?? '', /budget/);
});

test('runReviewWithBudget — shared turnId across retries', async () => {
  const seenIds: string[] = [];
  let calls = 0;
  const runner = async (turnId: string): Promise<HostReviewResult> => {
    seenIds.push(turnId);
    calls += 1;
    if (calls === 1) throw new Error('first fail');
    return PASS;
  };
  await runReviewWithBudget(runner, nextId, { totalBudgetMs: 400, maxRetries: 1 });
  assert.equal(seenIds.length, 2);
  assert.equal(seenIds[0], seenIds[1], 'same turnId used for both attempts');
});

test('runReviewWithBudget — reason distinguishes error from timeout', async () => {
  let calls = 0;
  const runner = async (_turnId: string): Promise<HostReviewResult> => {
    calls += 1;
    throw new Error('specific error message');
  };
  const result = await runReviewWithBudget(runner, nextId, {
    totalBudgetMs: 400,
    maxRetries: 0,
  });
  assert.equal(result.reviewed, false);
  assert.match(result.reason ?? '', /specific error message/, 'reason should include the error message');
});

test('runReviewWithBudget — timeout on first attempt, success on second (retry after timeout)', async () => {
  let calls = 0;
  let firstRunnerTimer: ReturnType<typeof setTimeout> | undefined;

  const runner = (_turnId: string): Promise<HostReviewResult> => {
    calls += 1;
    if (calls === 1) {
      // First attempt: slower than the per-attempt slot so it times out.
      return new Promise((resolve) => {
        // Hold for 2s — longer than the per-attempt slot (totalBudgetMs/2 = 250ms).
        // Clean up in finally below.
        firstRunnerTimer = setTimeout(() => resolve(PASS), 2_000);
      });
    }
    // Second attempt: fast success.
    return Promise.resolve(PASS);
  };

  try {
    const result = await runReviewWithBudget(runner, nextId, {
      totalBudgetMs: 500, // two 250ms slots
      maxRetries: 1,
    });
    assert.deepEqual(result, PASS, 'second attempt should succeed');
    assert.equal(calls, 2, 'should have attempted twice');
  } finally {
    if (firstRunnerTimer) clearTimeout(firstRunnerTimer);
  }
});
