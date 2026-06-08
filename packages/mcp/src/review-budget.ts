/**
 * Bounded review runner (REVIEW-ROBUSTNESS). Wraps any review runner with a hard
 * total wall-clock budget split evenly across attempts. Fails OPEN: if every
 * attempt times out or errors, returns {reviewed: false} so the caller can
 * continue without blocking.
 *
 * Design notes:
 *   - The budget is TOTAL (not per-attempt). It is divided evenly into `nAttempts`
 *     slots of `perAttemptMs` each.
 *   - A slot guard (with a small jitter allowance) prevents starting an attempt
 *     when the remaining budget is materially shorter than a full slot. This matters
 *     for synchronous CLI managers: Promise.race cannot preempt a synchronous
 *     spawnSync call; the OS-level CLI timeout in makeCliSpawn is the real backstop
 *     for a wedged child. Starting an attempt with an insufficient slot would still
 *     run the full spawnSync timeout and blow past the total budget.
 *   - CLI TIMEOUT ALIGNMENT: because Promise.race cannot preempt a synchronous
 *     spawnSync (nor the synchronous git diff acquisition that precedes it), a CLI
 *     review is bounded only by host-review's OS-level timeouts. So both call sites
 *     pass `{ totalBudgetMs: REVIEW_BUDGET_MS, maxRetries: 0 }` (a SINGLE attempt) and
 *     host-review sets the CLI's OS timeout to REVIEW_BUDGET_MS MINUS a diff-acquisition
 *     headroom, so diff-read + CLI spawn together stay within the budget — a hung CLI
 *     review can never overrun it. (A budget SHORTER than the CLI timeout, or equal to
 *     it without headroom for the synchronous diff read, would let one review overrun
 *     the whole budget — the bug this alignment fixes.) For API managers the fetch
 *     timeout (wrapWithFetchTimeout) is independently enforceable.
 *   - After a timeout, the superseded runner call continues until OS cleanup. A
 *     shared `turnId` across all retries ensures any late duplicate appendOutcome
 *     writes correlate to the same review subject in the ledger.
 *   - This module imports only node built-ins and `HostReviewResult` as a TYPE, so
 *     it can be imported directly by `node --test` without needing a build step.
 */

import type { HostReviewResult } from './host-review.ts';

/** Options for {@link runReviewWithBudget}. */
export interface ReviewBudgetOptions {
  /** Total wall-clock cap for ALL attempts combined (default 120 000 ms). */
  totalBudgetMs?: number;
  /**
   * Additional attempts after the first on timeout or error (default 1).
   * With the default, budget is split into two 60 s slots.
   */
  maxRetries?: number;
}

/**
 * Run a review with a bounded total wall-clock budget and an optional retry on
 * timeout or error. Fails OPEN: returns `{reviewed: false}` if every attempt
 * exhausts its slot or throws.
 *
 * @param runner  Async function that performs the review given a turn ID.
 * @param newId   Factory for a fresh ID (called once to generate the shared turn ID).
 * @param opts    Optional budget/retry overrides.
 */
export async function runReviewWithBudget(
  runner: (turnId: string) => Promise<HostReviewResult>,
  newId: () => string,
  opts?: ReviewBudgetOptions,
): Promise<HostReviewResult> {
  const totalBudgetMs = opts?.totalBudgetMs ?? 120_000;
  const maxRetries = opts?.maxRetries ?? 1;
  const nAttempts = maxRetries + 1;
  const perAttemptMs = Math.floor(totalBudgetMs / nAttempts);

  if (perAttemptMs <= 0) {
    return { reviewed: false, errored: true, reason: 'review budget too small' };
  }

  // One turn ID across all retries so any late duplicate appendOutcome writes
  // share the same review subject in the ledger.
  const turnId = newId();
  const deadlineAt = Date.now() + totalBudgetMs;
  let lastReason = 'review timed out';

  // Internal sentinel — distinguishes a timed-out/errored race from a real result.
  const TIMEOUT = Symbol('timeout');
  // Jitter allowance: JS timers can fire a few ms early/late. Without this, the
  // slot guard would falsely reject a retry attempt whose slot consumed the exact
  // per-attempt budget (remaining = perAttemptMs - ε after a timeout fires).
  const SLOT_JITTER_MS = 50;

  for (let i = 0; i < nAttempts; i++) {
    const remaining = deadlineAt - Date.now();
    const slotMs = Math.min(perAttemptMs, remaining);

    // Slot guard: don't start an attempt with materially less than a full slot.
    // For CLI managers, Promise.race can't fire while spawnSync blocks — a short
    // slot would still run the full CLI timeout and exceed the budget.
    if (slotMs < perAttemptMs - SLOT_JITTER_MS) break;

    const result = await new Promise<HostReviewResult | typeof TIMEOUT>((resolve) => {
      const timer = setTimeout(() => resolve(TIMEOUT), slotMs);

      // Wrap runner in Promise.resolve().then() so synchronous throws become
      // rejections and the timer is always cleared via the .then() error branch.
      Promise.resolve()
        .then(() => runner(turnId))
        .then(
          (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          (e: unknown) => {
            clearTimeout(timer);
            lastReason =
              e instanceof Error ? `review failed: ${e.message}` : 'review failed';
            resolve(TIMEOUT);
          },
        );
    });

    if (result !== TIMEOUT) return result; // success — return immediately
    // else: timed out or errored — continue to next attempt if budget allows
  }

  // Every attempt timed out or threw ⇒ fail OPEN, but flag it as an ERROR so the
  // Stop hook surfaces "not reviewed" instead of silently allowing as if it passed.
  return { reviewed: false, errored: true, reason: lastReason };
}
