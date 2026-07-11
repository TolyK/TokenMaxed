/**
 * F2/F3 — the review CHILD process shared by the IN-PROCESS host adapters
 * (OpenCode plugin under Bun, OpenClaw plugin in the Gateway). The whole
 * host-review path is deliberately synchronous (spawnSync git diffs + a
 * spawnSync CLI reviewer bounded by OS timeouts) — run in-process it would
 * freeze the host's event loop for up to REVIEW_BUDGET_MS. So each plugin
 * spawns THIS entry (bundled next to it as tokenmaxed-review.mjs)
 * asynchronously and reads ONE JSON action from stdout.
 *
 * Semantics mirror hook-stop-main's stopMain (same review runner, same pure
 * stopHookAction decision) — with ONE deliberate difference: this child NEVER
 * touches the loop counter. The PARENT plugin owns it (reads the prior count,
 * passes it in via TOKENMAXED_REVIEW_PRIOR_BLOCKS, and banks/resets it only at
 * the moment it acts on the returned action). A child that is killed, times
 * out, or races its stdout flush therefore can never "bank a phantom round" —
 * there is nothing here to write. The OUTPUT is the action for the plugin to
 * translate (block ⇒ rework prompt-back / finalize-revise, notify ⇒
 * toast/log). Kept as its own thin entry (like the per-host stop entries)
 * rather than a stopMain dialect, because the output here is an internal
 * protocol, not a host hook schema.
 *
 * argv[2] = the host session id (diagnostic only — no counter file here).
 * env TOKENMAXED_REVIEW_PRIOR_BLOCKS = the parent-owned prior round count.
 * Contract: exit 0 always; print exactly one JSON line:
 *   {"kind":"allow"} | {"kind":"notify","message":string} | {"kind":"block","reason":string}
 * Fail OPEN as {"kind":"allow"} only for unexpected crashes — reviewer errors
 * already surface through stopHookAction's own re-fire/notify protections.
 */

import { randomUUID } from 'node:crypto';

import { REVIEW_BUDGET_MS, makeHostReviewDeps, makeReviewRunner } from './host-review.ts';
import { runReviewWithBudget } from './review-budget.ts';
import { parseMaxRounds, reviewLoopEnabled, stopHookAction } from './reviewer.ts';
import { effectiveEnv } from './settings.ts';

/** The one-line action protocol the OpenCode plugin consumes. */
export type ReviewChildAction =
  | { kind: 'allow' }
  | { kind: 'notify'; message: string }
  | { kind: 'block'; reason: string };

async function main(): Promise<void> {
  const env = effectiveEnv(process.env);
  if (!reviewLoopEnabled(env)) return print({ kind: 'allow' });

  // The PARENT owns the loop counter — this is its prior round count (0 on
  // absence/garbage; a missing value must never manufacture extra rounds).
  // STRICT digits-only parse: parseInt would accept '1garbage' as 1; any
  // malformed value must degrade to 0 (never manufacture or inherit rounds).
  const rawPrior = env.TOKENMAXED_REVIEW_PRIOR_BLOCKS ?? '0';
  const priorBlocks = /^[0-9]+$/.test(rawPrior) ? Number.parseInt(rawPrior, 10) : 0;
  const maxRounds = parseMaxRounds(env);

  const result = await runReviewWithBudget(makeReviewRunner(makeHostReviewDeps(env)), randomUUID, {
    totalBudgetMs: REVIEW_BUDGET_MS,
    maxRetries: 0,
  });

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

  if (action.kind === 'allow') return print({ kind: 'allow' });
  if (action.kind === 'notify') return print({ kind: 'notify', message: action.message });
  return print({ kind: 'block', reason: action.reason });
}

/** Write the single action line and resolve once flushed (notes can be long). */
function print(action: ReviewChildAction): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(JSON.stringify(action) + '\n', () => resolve());
  });
}

try {
  await main();
} catch {
  await print({ kind: 'allow' }); // fail open — never wedge the host over the backstop
}
