/**
 * F2 — the OpenCode review CHILD process. The OpenCode plugin runs IN-PROCESS
 * under Bun, and the whole host-review path is deliberately synchronous
 * (spawnSync git diffs + a spawnSync CLI reviewer bounded by OS timeouts) — run
 * in-process it would freeze OpenCode's event loop for up to REVIEW_BUDGET_MS.
 * So the plugin spawns THIS entry (bundled next to it as tokenmaxed-review.mjs)
 * asynchronously and reads ONE JSON action from stdout.
 *
 * Semantics mirror hook-stop-main's stopMain (same review runner, same pure
 * stopHookAction decision, same per-session tmp counter with the never-stuck
 * write-failure rule) — only the OUTPUT differs: instead of a host block
 * payload, it prints the action for the plugin to translate (block ⇒ rework
 * prompt-back, notify ⇒ toast). Kept as its own thin entry (like the per-host
 * stop entries) rather than a fourth stopMain dialect, because the output here
 * is an internal protocol, not a host hook schema.
 *
 * argv[2] = the OpenCode session id (used only for the loop-counter file name).
 * Contract: exit 0 always; print exactly one JSON line:
 *   {"kind":"allow"} | {"kind":"notify","message":string} | {"kind":"block","reason":string}
 * Fail OPEN as {"kind":"allow"} only for unexpected crashes — reviewer errors
 * already surface through stopHookAction's own re-fire/notify protections.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REVIEW_BUDGET_MS, makeHostReviewDeps, makeReviewRunner } from './host-review.ts';
import { readCounter, writeCounter } from './hook-stop-main.ts';
import { runReviewWithBudget } from './review-budget.ts';
import { parseMaxRounds, reviewLoopEnabled, stopHookAction } from './reviewer.ts';
import { effectiveEnv } from './settings.ts';

/** The one-line action protocol the OpenCode plugin consumes. */
export type OpencodeReviewAction =
  | { kind: 'allow' }
  | { kind: 'notify'; message: string }
  | { kind: 'block'; reason: string };

async function main(): Promise<void> {
  const env = effectiveEnv(process.env);
  if (!reviewLoopEnabled(env)) return print({ kind: 'allow' });

  const sessionId = (process.argv[2] ?? 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
  const counterFile = join(tmpdir(), 'tokenmaxed-stop', sessionId);
  const maxRounds = parseMaxRounds(env);

  const result = await runReviewWithBudget(makeReviewRunner(makeHostReviewDeps(env)), randomUUID, {
    totalBudgetMs: REVIEW_BUDGET_MS,
    maxRetries: 0,
  });

  const priorBlocks = readCounter(counterFile);
  const action = stopHookAction({
    reviewed: result.reviewed,
    errored: result.errored,
    reason: result.reason,
    verdict: result.verdict,
    notes: result.notes,
    managerLaneId: result.managerLaneId,
    priorBlocks,
    maxRounds,
  });

  if (action.kind === 'allow') {
    writeCounter(counterFile, 0);
    return print({ kind: 'allow' });
  }
  if (action.kind === 'notify') {
    writeCounter(counterFile, 0);
    return print({ kind: 'notify', message: action.message });
  }
  // 'block' — only claim it if the incremented counter PERSISTS, else the loop
  // guard is defeated (the plugin would re-prompt forever). Same rule as stopMain.
  if (!writeCounter(counterFile, priorBlocks + 1)) {
    return print({
      kind: 'notify',
      message:
        '⚠ TokenMaxed: review wanted rework but the loop-state file could not be written; not re-prompting to avoid a loop. Notes: ' +
        action.reason,
    });
  }
  return print({ kind: 'block', reason: action.reason });
}

/** Write the single action line and resolve once flushed (notes can be long). */
function print(action: OpencodeReviewAction): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(JSON.stringify(action) + '\n', () => resolve());
  });
}

try {
  await main();
} catch {
  await print({ kind: 'allow' }); // fail open — never wedge the host over the backstop
}
