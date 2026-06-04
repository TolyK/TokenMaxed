#!/usr/bin/env node
/**
 * A-7 — Stop gate (OPT-IN). When TOKENMAXED_REVIEW_ON_STOP=true, review the
 * turn's working-tree diff with the configured manager; on a non-pass verdict,
 * BLOCK finishing and feed the reviewer notes back so Claude reworks.
 *
 * Loop guard: Claude Code has no built-in stop-loop protection, so we keep a
 * per-session block counter in a temp file and YIELD after MAX_BLOCKS to never
 * trap the user. Fails OPEN on any error (never wedge a session over a backstop).
 *
 * Contract: exit 0 always; allow ⇒ no output, block ⇒ {"decision":"block",...}.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeHostReviewDeps, makeReviewRunner } from './host-review.ts';
import { runReviewWithBudget } from './review-budget.ts';
import { stopGateDecision } from './reviewer.ts';

const MAX_BLOCKS = 2; // consecutive Stop blocks before yielding (loop guard)

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
  // Opt-in only; never run inside a recursion-guarded child.
  if (env.TOKENMAXED_REVIEW_ON_STOP !== 'true') return;
  if (env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true') return;

  let input: { session_id?: unknown } = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    /* no/invalid stdin */
  }
  const sessionId = (typeof input.session_id === 'string' ? input.session_id : 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
  const counterFile = join(tmpdir(), 'tokenmaxed-stop', sessionId);

  const deps = makeHostReviewDeps(env);
  // runReviewWithBudget caps the total wait to 120 s across up to 2 attempts, so
  // a hung API manager or a stalled CLI (the real backstop: OS spawnSync timeout)
  // can never wedge this Stop hook indefinitely. Fails OPEN on every error/timeout.
  const result = await runReviewWithBudget(makeReviewRunner(deps), randomUUID, {
    totalBudgetMs: 120_000,
    maxRetries: 1,
  });
  // Nothing to gate (no changes / no manager / pass) ⇒ allow + reset the counter.
  if (!result.reviewed || !result.verdict) {
    writeCounter(counterFile, 0);
    return;
  }

  const priorBlocks = readCounter(counterFile);
  const decision = stopGateDecision(result.verdict, priorBlocks, MAX_BLOCKS);
  if (!decision.block) {
    writeCounter(counterFile, 0); // pass, or yielded after the budget — reset
    return;
  }

  // Only block if we can PERSIST the incremented counter — otherwise the loop
  // guard would be defeated (every Stop re-reads 0 and blocks forever), so fail
  // open instead of risking trapping the session.
  if (!writeCounter(counterFile, priorBlocks + 1)) return;
  const head = `Manager review (${result.managerLaneId ?? 'manager'}) returned ${result.verdict}. Address the issues, then continue.`;
  // Put the reviewer's notes in BOTH the block reason (what drives the block) and
  // additionalContext, so Claude actually receives the actionable feedback.
  const reason = result.notes ? `${head}\n\nReviewer notes:\n${result.notes}` : head;
  // Await the flush: the block JSON can exceed the pipe buffer with verbose notes,
  // and exiting before it drains would truncate it (Claude would ignore the block).
  await writeStdout(
    JSON.stringify({
      decision: 'block',
      reason,
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason },
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
