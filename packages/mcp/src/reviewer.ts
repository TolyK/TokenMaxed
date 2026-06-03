/**
 * A-7 — pure manager-review helpers (no I/O). Shared by the router_review tool
 * and the opt-in Stop gate: build the review prompt, parse the manager's verdict,
 * and decide whether a Stop hook should block. Kept pure so it's unit-tested with
 * no build; the git/executor/ledger wiring lives in host-review.ts.
 */

import type { ManagerReviewOutput } from '@tokenmaxed/core';
import type { ReviewVerdict } from '@tokenmaxed/core';

/**
 * Trailing line the manager is asked to emit; parsed back into a verdict. Anchored
 * to a STANDALONE line (optionally quote-prefixed) — so a `VERDICT: pass` quoted
 * inside prose/code can't override the manager's real final verdict line.
 */
const VERDICT_RE = /^[ \t>]*VERDICT:\s*(pass|needs-rework|fail)\s*$/gim;

/**
 * Prompt the manager to review a diff and end with a machine-parseable verdict.
 * The manager is a TRUSTED lane, so it may see the full diff (no minimization).
 */
export function buildReviewPrompt(diff: string): string {
  return [
    'You are a senior code reviewer. Review the following working-tree diff for',
    'correctness, security, and obvious bugs. Be concise — list only real issues.',
    '',
    'End your reply with EXACTLY one final line, one of:',
    '  VERDICT: pass            (acceptable to ship)',
    '  VERDICT: needs-rework    (has issues that should be fixed)',
    '  VERDICT: fail            (seriously wrong; do not ship)',
    '',
    'Diff:',
    diff,
  ].join('\n');
}

/**
 * Parse a manager's free-text reply into a verdict + notes. FAIL OPEN: if no
 * explicit VERDICT line is found, treat it as `pass` (never trap the user on an
 * unparseable review) but keep the text as notes. The LAST verdict line wins.
 */
export function parseManagerVerdict(text: string): ManagerReviewOutput {
  let verdict: ReviewVerdict = 'pass';
  let matched = false;
  for (const m of text.matchAll(VERDICT_RE)) {
    verdict = m[1]!.toLowerCase() as ReviewVerdict;
    matched = true;
  }
  const notes = text.replace(VERDICT_RE, '').trim();
  const out: ManagerReviewOutput = { verdict };
  if (notes) out.notes = notes;
  // matched is informational; even unmatched we return pass (fail-open).
  void matched;
  return out;
}

/** A Stop-gate decision: whether to block finishing, and why. */
export interface StopGateDecision {
  block: boolean;
  reason?: string;
}

/**
 * Decide whether the Stop gate should block. Block when the verdict is not `pass`
 * AND we haven't already blocked `maxAttempts` times this session (loop guard —
 * Claude Code has no built-in stop-loop protection, so we yield after N to never
 * trap the user).
 */
export function stopGateDecision(
  verdict: ReviewVerdict,
  priorBlocks: number,
  maxAttempts: number,
): StopGateDecision {
  if (verdict === 'pass') return { block: false };
  if (priorBlocks >= maxAttempts) {
    return { block: false, reason: `review still ${verdict} after ${priorBlocks} rework attempt(s); yielding to avoid a loop` };
  }
  return { block: true, reason: verdict };
}
