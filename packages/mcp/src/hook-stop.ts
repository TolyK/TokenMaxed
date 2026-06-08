#!/usr/bin/env node
/**
 * REVIEW-LOOP — Stop gate (DEFAULT-ON when a reviewer lane exists). Reviews the
 * turn's working-tree diff (tracked AND untracked changes) with the configured
 * manager; on a non-pass verdict, BLOCK finishing and feed the reviewer notes
 * back so Claude reworks, then re-reviews — iterating until the reviewer passes.
 *
 * Protections (all decided in reviewer.ts, kept pure/testable):
 *   A — the review must actually run: on any reviewer error/timeout it RE-FIRES
 *       (blocks + retries on the next turn) instead of passing silently, so a
 *       transient git/reviewer hiccup self-heals and the review still happens.
 *   B — never stuck: a per-session block counter (temp file) bounds BOTH reworks
 *       and error-retries to maxRounds; on reaching it we YIELD with a clear
 *       message (so even a PERSISTENT failure can't trap the session).
 *   C — agent can't forget: this is a deterministic Stop hook (always runs) that
 *       always reports its terminal state (pass = silent, else surfaced).
 *
 * Opt out entirely with TOKENMAXED_REVIEW_ON_STOP=false (or no reviewer lane).
 *
 * Contract: exit 0 always; allow ⇒ no output, block ⇒ {"decision":"block",...},
 * terminal-to-surface ⇒ {"systemMessage":"..."}.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REVIEW_BUDGET_MS, makeHostReviewDeps, makeReviewRunner } from './host-review.ts';
import { runReviewWithBudget } from './review-budget.ts';
import { parseMaxRounds, reviewLoopEnabled, stopHookAction } from './reviewer.ts';

function readCounter(file: string): number {
  try {
    const n = Number.parseInt(readFileSync(file, 'utf8'), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Persist the block counter; returns false if it could not be written. */
function writeCounter(file: string, n: number): boolean {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, String(n), 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const env = process.env;
  // DEFAULT-ON: runs unless explicitly opted out (TOKENMAXED_REVIEW_ON_STOP=false)
  // or globally disabled (TOKENMAXED_DISABLE, also our recursion guard). When no
  // reviewer lane is configured the review no-ops downstream, so default-on means
  // "on whenever a usable reviewer exists" — the user's chosen posture.
  if (!reviewLoopEnabled(env)) return;

  let input: { session_id?: unknown } = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    /* no/invalid stdin */
  }
  const sessionId = (typeof input.session_id === 'string' ? input.session_id : 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
  const counterFile = join(tmpdir(), 'tokenmaxed-stop', sessionId);
  const maxRounds = parseMaxRounds(env);

  const deps = makeHostReviewDeps(env);
  // SINGLE attempt bounded by REVIEW_BUDGET_MS. A CLI review's spawnSync can't be
  // preempted by Promise.race, so the budget must COVER the CLI's own OS timeout PLUS
  // the synchronous diff acquisition that precedes it (host-review reserves that
  // headroom: CLI timeout = budget − headroom). A reasoning-model review of a real diff
  // genuinely takes minutes; a 2nd attempt on the same diff rarely helps and would
  // double the wall-clock. Fails OPEN on timeout/error (errored:true → surfaced).
  const result = await runReviewWithBudget(makeReviewRunner(deps), randomUUID, {
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
    // Silent pass / no-changes / no-reviewer ⇒ allow + reset the loop counter.
    writeCounter(counterFile, 0);
    return;
  }

  if (action.kind === 'notify') {
    // Terminal state worth surfacing (reviewer error, or yielded-unconverged) —
    // reset the counter, then emit a non-blocking systemMessage to the USER.
    writeCounter(counterFile, 0);
    await writeStdout(JSON.stringify({ systemMessage: action.message }));
    return;
  }

  // action.kind === 'block' — only block if we can PERSIST the incremented counter,
  // else the loop guard is defeated (every Stop re-reads the same count and blocks
  // forever). Fail OPEN, but SURFACE it (don't pretend the review passed).
  if (!writeCounter(counterFile, priorBlocks + 1)) {
    await writeStdout(
      JSON.stringify({
        systemMessage:
          '⚠ TokenMaxed: review wanted rework but the loop-state file could not be written; not blocking to avoid a stuck session. Run /tokenmaxed:review to see the notes.',
      }),
    );
    return;
  }
  // Await the flush: the block JSON can exceed the pipe buffer with verbose notes,
  // and exiting before it drains would truncate it (Claude would ignore the block).
  await writeStdout(
    JSON.stringify({
      decision: 'block',
      reason: action.reason,
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: action.reason },
    }),
  );
}

/** Write to stdout and resolve only once it has been flushed to the OS. */
function writeStdout(s: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(s, () => resolve());
  });
}

// Force-exit AFTER main settles. Safe because the only stdout write is awaited to
// flush inside main before it resolves; the forced exit then also tears down any
// lingering handle (e.g. a stalled API-manager fetch the deadline race can't
// abort), so the Stop hook can never keep the turn from finishing.
main()
  .catch(() => {
    /* fail open — never wedge a session over a backstop hook */
  })
  .finally(() => process.exit(0));
