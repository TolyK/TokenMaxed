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

import { isManagerEligible } from './route.ts';
import type { OutcomeEventInput, ReviewVerdict } from './ledger.ts';
import type { Lane, TaskCategory } from './types.ts';

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
