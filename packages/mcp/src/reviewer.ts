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

// ---------------------------------------------------------------------------
// REVIEW-LOOP (2026-06-07): the embedded, default-ON review-iterate rule. The
// reviewer reviews ALL the turn's changed code; on a non-pass verdict the agent
// reworks and it re-reviews, repeating until the reviewer passes — with three
// protections so the loop can never (A) be wedged by a reviewer error, (B) loop
// forever, or (C) finish silently when the user should know. A user opts out by
// configuring no reviewer lane, or explicitly via TOKENMAXED_REVIEW_ON_STOP=false.
//
// All the decision logic lives here (pure ⇒ unit-tested with no build); the Stop
// hook (hook-stop.ts) only does the git/manager/ledger I/O and writes the action.
// ---------------------------------------------------------------------------

/** Values that mean "off" for a default-ON switch (case-insensitive). */
const OFF_VALUES = new Set(['false', '0', 'off', 'no']);

/**
 * Whether the review-iterate loop runs this turn. It is ON BY DEFAULT — every
 * finishing turn is reviewed when a usable reviewer lane exists (if none is
 * configured the review no-ops downstream, so default-on == on-when-a-reviewer-
 * exists). Disable explicitly with TOKENMAXED_REVIEW_ON_STOP=false (or 0/off/no),
 * or globally with the TOKENMAXED_DISABLE kill-switch. Absence ⇒ on (the
 * default-on flip from the earlier opt-in gate); existing
 * TOKENMAXED_REVIEW_ON_STOP=true users are unaffected (still on).
 */
export function reviewLoopEnabled(env: Record<string, string | undefined>): boolean {
  if (env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true') return false;
  const v = env.TOKENMAXED_REVIEW_ON_STOP;
  if (v !== undefined && OFF_VALUES.has(v.trim().toLowerCase())) return false;
  return true;
}

/** Default number of rework rounds the loop drives before yielding (Protection B). */
export const DEFAULT_REVIEW_MAX_ROUNDS = 5;
const MAX_REVIEW_ROUNDS_CAP = 20;

/**
 * How many rework rounds the loop drives before it yields (Protection B —
 * bounded so it can never loop forever). Configurable via
 * TOKENMAXED_REVIEW_MAX_ROUNDS; clamped to [1, 20]; absent/invalid ⇒ default.
 */
export function parseMaxRounds(env: Record<string, string | undefined>): number {
  const raw = env.TOKENMAXED_REVIEW_MAX_ROUNDS;
  if (raw === undefined) return DEFAULT_REVIEW_MAX_ROUNDS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_REVIEW_MAX_ROUNDS;
  return Math.min(n, MAX_REVIEW_ROUNDS_CAP);
}

/** Max chars of reviewer notes surfaced/fed back (keeps messages bounded). */
const NOTES_SUMMARY_MAX = 1500;
function summarizeNotes(notes: string | undefined): string {
  const t = (notes ?? '').trim();
  if (!t) return '';
  return t.length > NOTES_SUMMARY_MAX ? `${t.slice(0, NOTES_SUMMARY_MAX)}\n…[notes truncated]` : t;
}

/** What the Stop hook should do this turn. */
export type StopHookAction =
  | { kind: 'allow' } // silent: passed, no changes, or no reviewer configured (the opt-out-by-absence)
  | { kind: 'block'; reason: string } // rework needed — feed the notes back, keep working
  | { kind: 'notify'; message: string }; // surface to the USER, then allow (a terminal state worth knowing)

/** Inputs the Stop hook feeds the pure decision after the bounded review ran. */
export interface StopHookInput {
  reviewed: boolean;
  /** true ⇒ review couldn't run because of an error/timeout (vs no-changes / no-reviewer). */
  errored?: boolean;
  reason?: string;
  verdict?: ReviewVerdict;
  notes?: string;
  managerLaneId?: string;
  /** Consecutive Stop blocks already issued this session (the loop counter). */
  priorBlocks: number;
  maxRounds: number;
}

/**
 * Decide the Stop hook's action — the heart of the default-on review-iterate
 * rule. Terminal states are ALWAYS explicit (Protection C: a deterministic gate
 * that the agent can't forget and that never finishes silently when the user
 * should know):
 *   - reviewed pass / no changes / no reviewer ⇒ allow (silent success or skip)
 *   - reviewer error or timeout                ⇒ notify (NEVER a silent pass — Protection A)
 *   - non-pass within the round budget         ⇒ block (rework, then re-review)
 *   - still non-pass at maxRounds              ⇒ notify + yield (Protection B — never stuck)
 */
export function stopHookAction(input: StopHookInput): StopHookAction {
  if (!input.reviewed) {
    if (input.errored) {
      const why = input.reason ? ` (${input.reason})` : '';
      return {
        kind: 'notify',
        message: `⚠ TokenMaxed: the manager review could not run${why}. Your changes were NOT reviewed — finishing without a verdict. Re-run /tokenmaxed:review to retry.`,
      };
    }
    // No working-tree changes, or no usable reviewer lane configured ⇒ silent
    // skip. "No reviewer" IS the zero-config opt-out the user chose.
    return { kind: 'allow' };
  }
  const verdict = input.verdict ?? 'pass';
  const decision = stopGateDecision(verdict, input.priorBlocks, input.maxRounds);
  if (decision.block) {
    const who = input.managerLaneId ?? 'manager';
    const head = `Manager review (${who}) returned ${verdict}. Address the issues, then continue.`;
    const notes = summarizeNotes(input.notes);
    return { kind: 'block', reason: notes ? `${head}\n\nReviewer notes:\n${notes}` : head };
  }
  // Not blocking: either a real pass (silent) or the loop-guard yield (surface it).
  if (decision.reason) {
    const notes = summarizeNotes(input.notes);
    const tail = notes ? `\n\nOutstanding reviewer notes:\n${notes}` : '';
    return {
      kind: 'notify',
      message: `⚠ TokenMaxed: review still "${verdict}" after ${input.priorBlocks} rework round(s) (max ${input.maxRounds}); yielding so you're not stuck. Review the changes yourself, or raise TOKENMAXED_REVIEW_MAX_ROUNDS.${tail}`,
    };
  }
  return { kind: 'allow' };
}
