/**
 * F5 — Hermes pre_verify shell hook (the turn-end review). Bundled to
 * hooks/pre-verify.cjs. pre_verify (Hermes >= 0.18.0) is a REAL Stop-block
 * equivalent, scoped to turns where the agent EDITED CODE: returning
 * {"action":"continue","message"} forces another agent iteration with the
 * message as a synthetic user turn; agent.max_verify_nudges (default 3) caps
 * it host-side, and `extra.attempt` tells us how many nudges already happened
 * this turn — which is exactly the prior-rounds input the shared pure
 * stopHookAction decision needs (no counter file: the host tracks the loop).
 *
 * The review runs INLINE (this hook is already a subprocess — the spawnSync
 * review path is fine here, same as the Claude/Codex Stop hooks) under a
 * 270s budget: Hermes clamps shell-hook timeouts at 300s and the recipe pins
 * `timeout: 300`, so the review must land inside it. Honesty note: narrower
 * than a true Stop hook — non-coding turns are never reviewed (Hermes only
 * fires pre_verify after code edits); documented in the README.
 *
 * Contract: exit 0 always; {} allows; {"action":"continue","message"} loops;
 * a terminal notify (reviewer error / yielded) goes to stderr (Hermes logs
 * hook stderr) with {} on stdout — never a fake block.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { HERMES_VERIFY_BUDGET_MS, hermesMaxRounds, hermesVerifyAttempt } from './hermes-hooks.ts';
import type { HermesHookPayload } from './hermes-hooks.ts';
import { makeHostReviewDeps, makeReviewRunner } from './host-review.ts';
import { REWORK_PROMPT_PREFIX } from './opencode-plugin.ts';
import { runReviewWithBudget } from './review-budget.ts';
import { reviewLoopEnabled, stopHookAction } from './reviewer.ts';
import { effectiveEnv } from './settings.ts';

async function main(): Promise<void> {
  let payload: HermesHookPayload = {};
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    /* fall through with defaults */
  }
  const env = effectiveEnv(process.env);
  if (!reviewLoopEnabled(env)) {
    process.stdout.write('{}');
    return;
  }

  // The budget threads into makeHostReviewDeps too: the CLI spawnSync timeout
  // derives from it (runReviewWithBudget alone can't preempt a spawnSync), so
  // the WHOLE chain lands inside Hermes's 300s hook clamp.
  const result = await runReviewWithBudget(makeReviewRunner(makeHostReviewDeps(env, { totalBudgetMs: HERMES_VERIFY_BUDGET_MS })), randomUUID, {
    totalBudgetMs: HERMES_VERIFY_BUDGET_MS,
    maxRetries: 0,
  });

  const action = stopHookAction({
    reviewed: result.reviewed,
    errored: result.errored,
    reason: result.reason,
    verdict: result.verdict,
    notes: result.notes,
    managerLaneId: result.managerLaneId,
    priorBlocks: hermesVerifyAttempt(payload), // the HOST tracks nudges this turn
    maxRounds: hermesMaxRounds(env), // min(TokenMaxed cap, Hermes nudge default) — see hermes-hooks.ts
  });

  if (action.kind === 'block') {
    await writeStdout(JSON.stringify({ action: 'continue', message: REWORK_PROMPT_PREFIX + action.reason }));
    return;
  }
  if (action.kind === 'notify') {
    process.stderr.write(`TokenMaxed: ${action.message}\n`); // Hermes logs hook stderr
  }
  await writeStdout('{}');
}

function writeStdout(s: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(s, () => resolve());
  });
}

void (async () => {
  try {
    await main();
  } catch {
    process.stdout.write('{}');
  }
})();
