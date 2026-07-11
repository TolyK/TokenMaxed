/**
 * F2/F3 — spawn the bundled review child (review-child-main.ts, shipped next to
 * each in-process host plugin as tokenmaxed-review.mjs) and parse its single
 * JSON action. Shared by the OpenCode and OpenClaw plugins: both run inside
 * their host's event loop, so the spawnSync-based review must live in a child.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REVIEW_BUDGET_MS } from './host-review.ts';
import { readCounter, writeCounter } from './hook-stop-main.ts';
import type { ReviewChildAction } from './review-child-main.ts';

/** Hard parent-side backstop over the child's own internal budget. */
export const REVIEW_CHILD_KILL_MS = REVIEW_BUDGET_MS + 30_000;

/**
 * The PARENT-owned per-session review-loop counter (the child is pure
 * computation and never writes — see review-child-main.ts). Same tmp path
 * shape the Claude/Codex Stop hooks use; injectable for tests.
 */
export interface LoopCounterStore {
  read: (sessionID: string) => number;
  /** Persist; false ⇒ could not write (callers must NOT iterate — never-stuck rule). */
  write: (sessionID: string, n: number) => boolean;
}

/** The real tmp-file counter store (shared path shape with the Stop hooks). */
export const fileLoopCounter: LoopCounterStore = {
  read: (sessionID) => readCounter(counterFile(sessionID)),
  write: (sessionID, n) => writeCounter(counterFile(sessionID), n),
};

function counterFile(sessionID: string): string {
  return join(tmpdir(), 'tokenmaxed-stop', sessionID.replace(/[^A-Za-z0-9_.-]/g, '_'));
}

/**
 * Spawn the bundled review child and parse its single-line JSON action. The
 * child is PURE COMPUTATION — the PARENT owns the loop counter (reads it,
 * threads the prior via env.TOKENMAXED_REVIEW_PRIOR_BLOCKS, and banks/resets
 * only when acting on the returned action) — so killing the child at any point
 * loses nothing but the review attempt itself. `opts.killAfterMs` lets an
 * in-process host bound the child under its own hook budget.
 */
export function spawnReviewChild(
  scriptPath: string,
  sessionID: string,
  env: NodeJS.ProcessEnv,
  opts: { killAfterMs?: number } = {},
): Promise<ReviewChildAction> {
  return new Promise((resolve, reject) => {
    if (!existsSync(scriptPath)) {
      reject(new Error(`review bundle not found next to the plugin: ${scriptPath} — copy plugin/tokenmaxed-review.mjs alongside the plugin file`));
      return;
    }
    const child = spawn(process.execPath, [scriptPath, sessionID], {
      env: env as Record<string, string>,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      fn();
    };
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      settle(() => reject(new Error('review child exceeded its budget')));
    }, opts.killAfterMs ?? REVIEW_CHILD_KILL_MS);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.on('error', (e) => settle(() => reject(e)));
    child.on('close', () =>
      settle(() => {
        try {
          const line = out.trim().split('\n').pop() ?? '';
          const parsed = JSON.parse(line) as ReviewChildAction;
          if (parsed.kind === 'allow' || parsed.kind === 'notify' || parsed.kind === 'block') {
            resolve(parsed);
            return;
          }
          reject(new Error('review child returned an unknown action'));
        } catch {
          reject(new Error('review child produced no parseable action'));
        }
      }),
    );
  });
}
