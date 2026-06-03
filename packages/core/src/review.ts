/**
 * Manager / reviewer (C-7). A configured, eligible manager model reviews a
 * router-managed task's output OR a host-turn diff and returns a verdict
 * (pass | needs-rework | fail) plus an optional reassignment suggestion. The
 * result is recorded as a content-free `outcome_event`.
 *
 * Pure — the manager model call is INJECTED. The manager must be a `full`/
 * trusted, manager-eligible lane (it sees the reviewed content); an ineligible
 * manager is refused. Reassignment ACTING on a verdict is C-8.
 */

import { evaluate, laneAllowedByVerdict } from './policy.ts';
import { capabilityFor, isManagerEligible, isSelectablePreGate } from './route.ts';
import type { OutcomeEventInput, ReviewVerdict } from './ledger.ts';
import type { Lane, Policy, RouteContext, TaskCategory } from './types.ts';

/** What the injected manager model returns after looking at the content. */
export interface ManagerReviewOutput {
  verdict: ReviewVerdict;
  /** Optional free-text notes — kept for the host UX, never written to the ledger. */
  notes?: string;
  /** Optional lane id the manager suggests reassigning to (C-8 may act on it). */
  suggested_lane_id?: string;
}

/** A request to review some produced work. */
export interface ReviewRequest {
  /** A router-managed task review carries `task_id`; a host-turn review carries `turn_id`. */
  task_id?: string;
  turn_id?: string;
  attempt?: number;
  category: TaskCategory;
  /** The diff/output to review (passed to the manager; never recorded). */
  content: string;
  /** The lane that produced the work (for a router_task review). */
  subjectLane?: Lane;
}

/** Injected dependencies for {@link review}. */
export interface ReviewDeps {
  /** The configured manager lane (must be manager-eligible). */
  managerLane: Lane;
  /** Run the manager model over the content and return its verdict. */
  runManagerReview: (managerLane: Lane, content: string, category: TaskCategory) => Promise<ManagerReviewOutput>;
  newId: () => string;
}

/** Raised when review is asked of an ineligible manager or a malformed request. */
export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
  }
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  notes?: string;
  suggested_lane_id?: string;
  /** The content-free outcome event to append to the ledger. */
  event: OutcomeEventInput;
}

/**
 * Review produced work with the configured manager and build a content-free
 * outcome event. The manager must be manager-eligible (full + trusted-origin or
 * attested). A `router_task` review requires `task_id`; a `host_turn` review
 * requires `turn_id`.
 */
export async function review(request: ReviewRequest, deps: ReviewDeps): Promise<ReviewResult> {
  if (!isManagerEligible(deps.managerLane)) {
    throw new ReviewError(
      `manager lane "${deps.managerLane.id}" is not manager-eligible (needs full trust + manager_allowed + trusted origin/attestation)`,
    );
  }
  // A review is for a router task OR a host turn — exactly one NON-EMPTY id.
  const isNonEmpty = (s: string | undefined): s is string => typeof s === 'string' && s.trim() !== '';
  const hasTask = isNonEmpty(request.task_id);
  const hasTurn = isNonEmpty(request.turn_id);
  if (hasTask === hasTurn) {
    throw new ReviewError(
      'review requires exactly one non-empty id: task_id (router_task) or turn_id (host_turn)',
    );
  }
  const subject_type = hasTask ? 'router_task' : 'host_turn';
  const subject_id = (hasTask ? request.task_id : request.turn_id) as string;

  const out = await deps.runManagerReview(deps.managerLane, request.content, request.category);

  const m = deps.managerLane;
  const event: OutcomeEventInput = {
    subject_id,
    subject_type,
    review_id: deps.newId(),
    attempt: request.attempt ?? 0,
    category: request.category,
    reviewer_lane_id: m.id,
    reviewer_model: m.model,
    reviewer_trust_mode: m.trust_mode,
    reviewer_provenance: m.provenance,
    verdict: out.verdict,
    voter: 'reviewer_model',
    policy_verdict: 'allow', // the manager is trusted and may see the content
  };
  if (hasTask) event.task_id = request.task_id;
  if (hasTurn) event.turn_id = request.turn_id;
  if (request.subjectLane) {
    event.subject_lane_id = request.subjectLane.id;
    event.subject_provenance = request.subjectLane.provenance;
  }

  const result: ReviewResult = { verdict: out.verdict, event };
  if (out.notes !== undefined) result.notes = out.notes;
  if (out.suggested_lane_id !== undefined) result.suggested_lane_id = out.suggested_lane_id;
  return result;
}

// ---------------------------------------------------------------------------
// C-13 (E-3): pure helpers for quality-driven escalation's REVIEW step. The
// orchestrator (runWithEscalation) composes these; the adapter injects only the
// raw manager executor.
// ---------------------------------------------------------------------------

/** Max chars of subtask/output handed to the manager (size bound — see plan). */
export const REVIEW_OUTPUT_MAX_CHARS = 32_000;

function capText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n\n[truncated for review]` : s;
}

/**
 * Build the prompt to review a DELEGATED SUBTASK'S OUTPUT (distinct from the
 * host-diff review prompt). The output goes only to a TRUSTED manager. Both the
 * subtask and the output are size-capped. The manager must end with a strict
 * final `VERDICT:` line (see {@link parseManagerVerdictStrict}).
 */
export function buildOutputReviewPrompt(subtask: string, output: string, maxChars: number = REVIEW_OUTPUT_MAX_CHARS): string {
  return [
    'You are a senior code reviewer. A subtask was delegated to another model;',
    'review its OUTPUT below for correctness, completeness, and obvious bugs. Be',
    'concise — list only real, blocking issues (not subjective polish).',
    '',
    'End your reply with EXACTLY one final line, one of:',
    '  VERDICT: pass            (acceptable as-is)',
    '  VERDICT: needs-rework    (has blocking issues to fix)',
    '  VERDICT: fail            (wrong / unusable)',
    '',
    'Subtask:',
    capText(subtask, maxChars),
    '',
    'Output to review:',
    capText(output, maxChars),
  ].join('\n');
}

/**
 * STRICT verdict parse for the automatic escalation gate: the manager's FINAL
 * non-empty line must be EXACTLY `VERDICT: pass|needs-rework|fail` (an echoed or
 * quoted verdict earlier in the notes does NOT count). Returns the verdict, or
 * `null` when absent/unparseable — the orchestrator treats `null` as
 * "review unavailable" (never a silent `pass`). This is intentionally stricter
 * than the lenient parser used for manual review.
 */
export function parseManagerVerdictStrict(text: string): ReviewVerdict | null {
  const lines = text.split('\n').map((l) => l.trim());
  let last = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] !== '') {
      last = lines[i]!;
      break;
    }
  }
  const m = /^VERDICT:\s*(pass|needs-rework|fail)$/i.exec(last);
  return m ? (m[1]!.toLowerCase() as ReviewVerdict) : null;
}

/**
 * Choose an INDEPENDENT manager to review an offloaded subtask's output (C-13).
 * Stricter than the host-turn manager: it must be manager-eligible, executable
 * (not `native`), NOT the subject lane (no self-review), **marginal-free**
 * (`subscription`/`local` — v1 adds no metered $), **at least as capable** as the
 * subject for the category (a weaker lane can't credibly judge a stronger one),
 * not policy-disabled, gate-selectable, and policy-allowed. Most capable wins
 * (tie-break by id). Returns `null` ⇒ no auto-review (review_unavailable).
 */
export function selectReviewManager(
  lanes: readonly Lane[],
  subject: Lane,
  category: TaskCategory,
  ctx: RouteContext,
  policy: Policy,
): Lane | null {
  const subjectCap = capabilityFor(subject, category);
  const disabled = new Set(policy.disabledLaneIds ?? []);
  const gateReady = ctx.gateReady ?? false;
  const policyContext = ctx.policyContext ?? {};
  const eligible = lanes.filter(
    (m) =>
      m.id !== subject.id &&
      !m.native &&
      isManagerEligible(m) &&
      (m.costBasis === 'subscription' || m.costBasis === 'local') &&
      capabilityFor(m, category) >= subjectCap &&
      !disabled.has(m.id) &&
      isSelectablePreGate(m, gateReady) &&
      laneAllowedByVerdict(m, evaluate({ category }, m, policyContext, policy).verdict),
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const byCap = capabilityFor(b, category) - capabilityFor(a, category);
    if (byCap !== 0) return byCap;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return eligible[0]!;
}
