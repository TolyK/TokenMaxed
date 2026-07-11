/**
 * runTask (C-6): orchestrate one task end-to-end. Pure — all execution I/O is
 * INJECTED (executors, secret scanner, lane→DTO resolver, clock/id), so the
 * orchestration is fully testable and core stays node-free. The concrete
 * executors are wired in later (C-9).
 *
 * Flow: routeDecide → if a full (trusted) lane runs it directly; if a worker lane,
 * minimize → executeUntrusted. On any block/failure, **degrade to native** (the
 * host does it) and record the attempt. Records produce content-free TaskEvent
 * inputs (the caller appends them) carrying status ok|failed|blocked and the
 * policy verdict; both savings numbers fall out of the cost primitives.
 */

import { computeCostPrimitives } from './price.ts';
import type { PriceTable } from './price.ts';
import { minimize, minimizeForReader } from './minimize.ts';
import type { MinimizedAttachment, SecretScanner } from './minimize.ts';
import { routeDecide } from './route.ts';
import { resolveUsage, usageFromReported } from './usage.ts';
import type { RawUsage, ResolvedUsage } from './usage.ts';
import { READER_SYSTEM_FRAMING, WORKER_SYSTEM_FRAMING } from './boundary.ts';
import type { SafeReaderEnvelope, SafeUntrustedEnvelope, UntrustedLaneDTO } from './boundary.ts';
import { parseGiveBackSignal } from './access.ts';
import { isTransient, LaneFailure, shouldCooldown } from './failure.ts';
import type { FailureKind } from './failure.ts';
import { escalationDecision, selectEscalationTarget, TRUST_RANK } from './reassign.ts';
import { buildOutputReviewPrompt, parseManagerVerdictStrict, review, selectReviewManager, REVIEW_OUTPUT_MAX_CHARS } from './review.ts';
import type { DifficultyBucket, OutcomeAction, OutcomeEventInput, ReviewVerdict, TaskEventInput, TaskStatus } from './ledger.ts';
import type { Lane, Policy, PolicyContext, RouteContext, RouteDecision, Task, TaskCategory } from './types.ts';

/** A unit of work to run (the content the lane needs, beyond the routing category). */
export interface RunRequest {
  /** Logical task id; one is generated if absent (groups retries/reassignments). */
  task_id?: string;
  /** Attempt index for this logical task (default 0); set by fallback for retries. */
  attempt?: number;
  category: TaskCategory;
  /**
   * Optional expected difficulty (P6 §4). Threads into {@link Task.difficulty} so
   * routing conditions on the difficulty-specific learned record when evidence
   * exists. Absent ⇒ category-level routing, unchanged.
   */
  difficulty?: DifficultyBucket;
  /** The scoped instruction to perform. */
  instruction: string;
  attachments?: MinimizedAttachment[];
  policyContext?: PolicyContext;
}

/** What a trusted-lane executor returns. `native: true` means "the host did it". */
export interface TrustedExecResult {
  resultText: string;
  reported?: RawUsage;
  /**
   * true ⇒ `reported` is a COMPLETE total that includes ESTIMATED parts (a recovery
   * retry where a call omitted provider `usage`), so it must be logged
   * `tokens_estimated: true` even though numbers are present — never as exact.
   */
  reportedEstimated?: boolean;
  native?: boolean;
}

/** What an untrusted-lane executor returns (content-free error on failure). */
export interface UntrustedExecResultLite {
  ok: boolean;
  resultText?: string;
  reported?: RawUsage;
  /** true ⇒ `reported` includes ESTIMATED parts (recovery retry; log estimated, not exact). */
  reportedEstimated?: boolean;
  error?: string;
  /** Normalized failure category (drives trust-preserving fallback). */
  failureKind?: FailureKind;
}

/** Injected dependencies (all I/O). */
export interface RunDeps {
  executeTrusted: (lane: Lane, instruction: string, attachments?: MinimizedAttachment[]) => Promise<TrustedExecResult>;
  executeUntrusted: (env: SafeUntrustedEnvelope) => Promise<UntrustedExecResultLite>;
  /** Resolve a worker lane to its narrow egress DTO (endpoint/authHandle from config). */
  untrustedLaneDTO: (lane: Lane) => UntrustedLaneDTO;
  /** F-2: execute a reader lane over the reader egress boundary. Optional — absent ⇒ reader lanes degrade to native. */
  executeReader?: (env: SafeReaderEnvelope) => Promise<UntrustedExecResultLite>;
  /** F-2: resolve a reader lane to its narrow egress DTO. Optional (pairs with executeReader). */
  readerLaneDTO?: (lane: Lane) => UntrustedLaneDTO;
  scanSecrets: SecretScanner;
  priceTable: PriceTable;
  newId: () => string;
}

/** The outcome of running one task. */
export interface RunResult {
  /** The routing decision (absent when no lane was selectable and we degraded to native). */
  decision?: RouteDecision;
  laneId: string;
  status: TaskStatus;
  /** Result text from the lane (absent when the host must do it). */
  resultText?: string;
  /** true ⇒ degraded/assigned to native: the host should perform the task itself. */
  native?: boolean;
  /** Normalized failure category when status is failed/blocked (drives fallback). */
  failureKind?: FailureKind;
  /**
   * F-2 taint: true ⇒ this result text came from a `reader` lane and may echo
   * private repo code. It must never be fed to a `worker` lane or placed in a
   * contentful log, and should be scanned before any further non-full egress.
   */
  readerDerived?: boolean;
  /** Content-free task events to append to the ledger (attempt records). */
  events: TaskEventInput[];
}

const ZERO_USAGE: ResolvedUsage = { tokens_in: 0, tokens_out: 0, tokens_estimated: true };

/**
 * {@link resolveUsage}, but FORCE the estimated flag when the executor reported a
 * total it had to partly estimate (a recovery retry where a provider omitted
 * `usage`). The numbers are the complete best-effort total; the flag honestly marks
 * it non-exact rather than recording an estimate-blended sum as provider-reported.
 */
function resolveUsageMaybeEstimated(
  args: { reported?: RawUsage; promptText?: string; resultText?: string },
  reportedEstimated?: boolean,
): ResolvedUsage {
  const usage = resolveUsage(args);
  return reportedEstimated && !usage.tokens_estimated ? { ...usage, tokens_estimated: true } : usage;
}

/** Text used for token estimation when a lane doesn't report usage (incl. attachments). */
function combinedText(instruction: string, attachments?: readonly { content: string }[]): string {
  return attachments && attachments.length > 0
    ? [instruction, ...attachments.map((a) => a.content)].join('\n')
    : instruction;
}

export async function runTask(
  request: RunRequest,
  ctx: RouteContext,
  policy: Policy,
  deps: RunDeps,
): Promise<RunResult> {
  // One policy context drives BOTH routing and minimization. A context on the
  // request overrides the one on ctx; otherwise ctx's is used for both.
  const effectiveCtx: RouteContext = request.policyContext
    ? { ...ctx, policyContext: request.policyContext }
    : ctx;
  const policyContext: PolicyContext = effectiveCtx.policyContext ?? {};

  // If routing has no selectable lane (e.g. only a worker, gate not ready, or
  // policy blocks everything), degrade to native rather than throwing.
  let decision: RouteDecision;
  try {
    decision = routeDecide(
      { category: request.category, ...(request.difficulty ? { difficulty: request.difficulty } : {}) },
      effectiveCtx,
      policy,
    );
  } catch {
    // No selectable lane (lanes empty, gated, disabled, or policy-blocked — e.g. a
    // reader lane blocked on a private/unknown repo). The host does it, but we leave
    // a content-free breadcrumb so this silent degrade is visible in the ledger.
    // There is no lane/decision here, so synthesize a host identity inline (the
    // `event` closure below needs `lane`/`decision`, which don't exist yet). Zero
    // spend/tokens; summarize() counts it as a native fallback, never an offload.
    const breadcrumb: TaskEventInput = {
      task_id: request.task_id ?? deps.newId(),
      attempt: request.attempt ?? 0,
      category: request.category,
      laneId: 'native',
      model: 'native',
      trust_mode: 'full',
      provenance: 'host',
      status: 'native',
      tokens_in: 0,
      tokens_out: 0,
      tokens_estimated: true,
      actual_cost: 0,
      frontier_cost: 0,
      metered_spent: 0,
      frontier_avoided: 0,
      metered_avoided: 0,
      policy_verdict: 'allow',
      native_reason: 'no_route',
    };
    return { laneId: 'native', status: 'ok', native: true, events: [breadcrumb] };
  }
  const lane = effectiveCtx.lanes.find((l) => l.id === decision.laneId)!;
  const task_id = request.task_id ?? deps.newId();

  const event = (status: TaskStatus, usage: ResolvedUsage): TaskEventInput => {
    const prim = computeCostPrimitives(deps.priceTable, lane, {
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
    });
    return {
      task_id,
      attempt: request.attempt ?? 0,
      category: request.category,
      laneId: lane.id,
      model: lane.model,
      trust_mode: lane.trust_mode,
      provenance: lane.provenance,
      status,
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      tokens_estimated: usage.tokens_estimated,
      ...prim,
      policy_verdict: decision.policyVerdict,
    };
  };

  // --- full (trusted) lane: execute directly with full context ---
  if (lane.trust_mode === 'full') {
    try {
      const r = await deps.executeTrusted(lane, request.instruction, request.attachments);
      if (r.native) {
        // The host performed it — usage is unobservable (never lie about tokens), so
        // the breadcrumb carries ZERO_USAGE. status 'native' + reason 'host_native'
        // makes the degrade visible without claiming spend; summarize() counts it as
        // a native fallback, never an offload.
        return {
          decision,
          laneId: lane.id,
          status: 'ok',
          native: true,
          resultText: r.resultText,
          events: [{ ...event('native', ZERO_USAGE), native_reason: 'host_native' }],
        };
      }
      const usage = resolveUsageMaybeEstimated(
        {
          reported: r.reported,
          promptText: combinedText(request.instruction, request.attachments),
          resultText: r.resultText,
        },
        r.reportedEstimated,
      );
      return { decision, laneId: lane.id, status: 'ok', resultText: r.resultText, events: [event('ok', usage)] };
    } catch (err) {
      // Preserve a typed lane failure (e.g. 402/429/401) so fallback can cool down
      // or stop; otherwise treat an unknown throw as a transient provider error.
      const failureKind: FailureKind = err instanceof LaneFailure ? err.failureKind : 'provider_error';
      // Preserve any spend the lane billed BEFORE throwing (e.g. a reasoning model
      // that billed a first call, then the retry failed) so a metered failed attempt
      // is never under-recorded as ZERO_USAGE.
      const usage = err instanceof LaneFailure && err.reported ? usageFromReported(err.reported) : ZERO_USAGE;
      return { decision, laneId: lane.id, status: 'failed', native: true, failureKind, events: [event('failed', usage)] };
    }
  }

  // --- reader (F-2) lane: minimizeForReader (repo-read allowed, secret-gated),
  // then execute over the reader egress boundary. Output is tainted reader-derived. ---
  if (lane.trust_mode === 'reader') {
    // Missing executor wiring ⇒ degrade to native rather than mis-route (defensive;
    // selectability already requires the egress opt-in to reach here).
    if (!deps.executeReader || !deps.readerLaneDTO) {
      return { decision, laneId: lane.id, status: 'blocked', native: true, failureKind: 'policy_blocked', events: [event('blocked', ZERO_USAGE)] };
    }
    const rmin = await minimizeForReader(
      {
        instruction: request.instruction,
        category: request.category,
        ...(request.attachments ? { attachments: request.attachments } : {}),
        ...(policyContext.repo_class ? { repo_class: policyContext.repo_class } : {}),
        ...(policyContext.sensitivity ? { sensitivity: policyContext.sensitivity } : {}),
      },
      deps.scanSecrets,
    );
    if (!rmin.ok) {
      return { decision, laneId: lane.id, status: 'blocked', native: true, failureKind: 'policy_blocked', events: [event('blocked', ZERO_USAGE)] };
    }
    try {
      const env: SafeReaderEnvelope = { payload: rmin.payload, lane: deps.readerLaneDTO(lane) };
      // Estimate from the SAME text the reader actually receives — including the
      // answer-only system framing buildReaderRequestBody prepends — so a
      // non-reporting endpoint's input tokens aren't undercounted.
      const promptText = combinedText(
        [READER_SYSTEM_FRAMING, rmin.payload.instruction].join('\n\n'),
        rmin.payload.attachments,
      );
      const r = await deps.executeReader(env);
      if (!r.ok) {
        const usage = r.reported ? usageFromReported(r.reported) : ZERO_USAGE;
        return {
          decision,
          laneId: lane.id,
          status: 'failed',
          native: true,
          failureKind: r.failureKind ?? 'provider_error',
          events: [event('failed', usage)],
        };
      }
      const usage = resolveUsageMaybeEstimated({ reported: r.reported, promptText, resultText: r.resultText }, r.reportedEstimated);
      return { decision, laneId: lane.id, status: 'ok', resultText: r.resultText, readerDerived: true, events: [event('ok', usage)] };
    } catch {
      return { decision, laneId: lane.id, status: 'failed', native: true, failureKind: 'provider_error', events: [event('failed', ZERO_USAGE)] };
    }
  }

  // --- worker (untrusted) lane: minimize, then execute ---
  const min = await minimize(
    {
      instruction: request.instruction,
      category: request.category,
      ...(request.attachments ? { attachments: request.attachments } : {}),
      ...(policyContext.repo_class ? { repo_class: policyContext.repo_class } : {}),
      ...(policyContext.sensitivity ? { sensitivity: policyContext.sensitivity } : {}),
    },
    deps.scanSecrets,
  );
  if (!min.ok) {
    // Could not safely minimize ⇒ degrade to native; record a blocked attempt.
    // policy_blocked is permanent (not a health issue), so it won't trigger fallback.
    return { decision, laneId: lane.id, status: 'blocked', native: true, failureKind: 'policy_blocked', events: [event('blocked', ZERO_USAGE)] };
  }

  try {
    const env: SafeUntrustedEnvelope = { payload: min.payload, lane: deps.untrustedLaneDTO(lane) };
    // Estimate from the SAME text the worker receives — including the answer-only
    // WORKER_SYSTEM_FRAMING buildUntrustedRequestBody prepends — so a non-reporting
    // endpoint's input tokens aren't undercounted.
    const promptText = combinedText([WORKER_SYSTEM_FRAMING, min.payload.instruction].join('\n\n'), min.payload.attachments);
    const r = await deps.executeUntrusted(env);
    if (!r.ok) {
      // Preserve any spend the lane reported before failing (even partial), rather
      // than estimating — so failed metered attempts are never under-reported.
      const usage = r.reported ? usageFromReported(r.reported) : ZERO_USAGE;
      return {
        decision,
        laneId: lane.id,
        status: 'failed',
        native: true,
        failureKind: r.failureKind ?? 'provider_error',
        events: [event('failed', usage)],
      };
    }
    const usage = resolveUsageMaybeEstimated({ reported: r.reported, promptText, resultText: r.resultText }, r.reportedEstimated);
    // Tandem give-back: a worker that can't finish without repo/tool context it was
    // never given emits the INSUFFICIENT_CONTEXT sentinel. That is NOT a quality
    // failure — the worker correctly recognized a boundary — so we record the spend
    // honestly as a `fallback` (never claims savings) and hand the task to the host
    // (native), surfacing the worker's stated need as the result text. No review is
    // run, so this never feeds the F-1 capability overlay.
    const giveBack = parseGiveBackSignal(r.resultText ?? '');
    if (giveBack.insufficient) {
      return {
        decision,
        laneId: lane.id,
        status: 'fallback',
        native: true,
        failureKind: 'insufficient_context',
        resultText: giveBack.needed || 'worker lacked required repository/tool context',
        events: [event('fallback', usage)],
      };
    }
    return { decision, laneId: lane.id, status: 'ok', resultText: r.resultText, events: [event('ok', usage)] };
  } catch {
    return { decision, laneId: lane.id, status: 'failed', native: true, failureKind: 'provider_error', events: [event('failed', ZERO_USAGE)] };
  }
}

/** Options for {@link runWithFallback}. */
export interface FallbackOptions {
  /** Max fallback hops after the first attempt (loop-guard; default 2). */
  maxFallbacks?: number;
  /** Lanes currently on cooldown (excluded from the start) — e.g. recent quota/rate hits. */
  cooldownLaneIds?: ReadonlySet<string>;
}

/** Result of {@link runWithFallback}: the final run plus aggregated events + cooldown adds. */
export interface FallbackResult extends RunResult {
  /** Total attempts made (1 + fallbacks). */
  attempts: number;
  /** Lanes that hit quota/rate this run and should be put on cooldown by the caller. */
  cooldownAdds: string[];
}

/**
 * Run a task with **trust-preserving** lane→lane fallback. On a TRANSIENT failure
 * (timeout / rate-limit / out-of-credits / provider 5xx), retry on a different
 * lane — but NEVER below the failed lane's trust tier (a trusted lane being out
 * of credits never falls back to a cheaper/less-trusted model). When no eligible
 * lane remains, or the failure is permanent (auth/bad-request/policy), it stops
 * and degrades to native. Loop-guarded; quota/rate failures suggest a cooldown.
 *
 * Pure: composes {@link runTask}; the caller persists cooldowns and appends events.
 */
export async function runWithFallback(
  request: RunRequest,
  ctx: RouteContext,
  policy: Policy,
  deps: RunDeps,
  opts: FallbackOptions = {},
): Promise<FallbackResult> {
  const maxFallbacks = opts.maxFallbacks ?? 2;
  const excluded = new Set<string>(opts.cooldownLaneIds ?? []);
  const cooldownAdds: string[] = [];
  const allEvents: TaskEventInput[] = [];
  let trustFloor = 0; // never reassign below this rank (set to a failed lane's rank)
  let last: RunResult | undefined;
  let attempts = 0;
  // One logical task id across all attempts, with an incrementing attempt index,
  // so the failed + successful fallback events correlate in the ledger.
  const task_id = request.task_id ?? deps.newId();

  for (let i = 0; i <= maxFallbacks; i++) {
    const lanes = ctx.lanes.filter(
      (l) => !excluded.has(l.id) && TRUST_RANK[l.trust_mode] >= trustFloor,
    );
    const result = await runTask({ ...request, task_id, attempt: i }, { ...ctx, lanes }, policy, deps);

    // A FALLBACK iteration that found no routable candidate (decision undefined —
    // remaining lanes are gated/reader/empty) didn't really run; keep the real
    // prior failure rather than overwriting it with a native degrade.
    if (i > 0 && result.decision === undefined) break;

    last = result;
    attempts += 1;
    allEvents.push(...result.events);

    // Success (executed or host-native) ⇒ done.
    if (result.status === 'ok') break;

    // Failure: only TRANSIENT failures are eligible for lane→lane fallback.
    const kind = result.failureKind;
    if (!kind || !isTransient(kind)) break; // permanent ⇒ no fallback

    // Cool down a quota/rate-exhausted lane EVEN on the last attempt, so the
    // caller doesn't immediately route the next task back to it.
    if (shouldCooldown(kind)) cooldownAdds.push(result.laneId);
    if (i >= maxFallbacks) break; // loop-guard

    // Exclude the failed lane; never fall below its trust tier (trust-preserving).
    excluded.add(result.laneId);
    const failedRank = TRUST_RANK[ctx.lanes.find((l) => l.id === result.laneId)?.trust_mode ?? 'blocked'];
    trustFloor = Math.max(trustFloor, failedRank);
    // Loop: re-route over the remaining, trust-floored lanes (or degrade to native).
  }

  return { ...(last as RunResult), events: allEvents, attempts, cooldownAdds };
}

// ===========================================================================
// C-13: quality-driven escalation orchestrator (pure; executors + manager
// INJECTED). Offload → review the OUTPUT with an independent manager → on a
// non-pass verdict, one same-lane rework and/or escalate UP the capability
// ladder, bounded; else give back to the host. Latency is bounded by the
// injected executors (e.g. CLI spawn timeout) + an adapter-level guard (E-5);
// this core stays clock-free for deterministic testing.
// ===========================================================================

/** A causal-order ledger event from an escalation run (discriminated). */
export type EscalationEvent =
  | { kind: 'task'; event: TaskEventInput }
  | { kind: 'outcome'; event: OutcomeEventInput };

/** Top-level disposition of an escalation run (for the adapter to render). */
export type EscalationFinalAction =
  | 'accept'
  | 'accept_after_rework'
  | 'accept_after_escalation'
  | 'give_back'
  | 'review_unavailable';

/** Injected deps for {@link runWithEscalation}: run deps + a raw manager executor. */
export interface EscalationDeps extends RunDeps {
  /** Run the manager lane over a prompt, returning its raw text reply. */
  runManager: (managerLane: Lane, prompt: string) => Promise<string>;
}

/** Tuning for {@link runWithEscalation}. */
export interface EscalationOptions {
  /** Max same-lane reworks (default 1). */
  maxReworks?: number;
  /** Max escalations (default 1). */
  maxEscalations?: number;
  /** Required capability improvement for an escalation target (default 0.15). */
  minCapabilityDelta?: number;
  /** Candidate lanes for manager + target selection (default ctx.lanes). */
  candidates?: readonly Lane[];
}

/** The outcome of an escalation run. */
export interface EscalationResult {
  final_action: EscalationFinalAction;
  reason?: string;
  verdict?: ReviewVerdict;
  notes?: string;
  subjectLaneId: string;
  targetLaneId?: string;
  /** The final RunResult (accepted offload, or the give-back/native result). */
  result: RunResult;
  /** Task + outcome events in CAUSAL order; the caller persists them in order. */
  events: EscalationEvent[];
}

const isMarginalFree = (lane: Lane): boolean => lane.costBasis === 'subscription' || lane.costBasis === 'local';

/** Append the manager's notes to the instruction for a rework/escalation re-run. */
function instructionWithNotes(instruction: string, notes: string | undefined): string {
  if (!notes) return instruction;
  const capped = notes.length > REVIEW_OUTPUT_MAX_CHARS ? `${notes.slice(0, REVIEW_OUTPUT_MAX_CHARS)}\n[truncated]` : notes;
  return `${instruction}\n\nReviewer notes (address these; do not rewrite blindly):\n${capped}`;
}

/**
 * Mark non-delivered task legs `superseded` for honest savings: only the FINAL
 * leg is delivered on an accept (incl. after rework/escalation) or a
 * review_unavailable; on give_back nothing is delivered. A superseded leg's
 * spend/tokens still count, but it never claims frontier_avoided (see
 * ledger.summarize). Mutates the events in place.
 */
function markSupersededLegs(events: EscalationEvent[], finalAction: EscalationFinalAction): void {
  const taskEvents = events.filter((e): e is Extract<EscalationEvent, { kind: 'task' }> => e.kind === 'task');
  if (taskEvents.length === 0) return;
  const delivered = finalAction !== 'give_back';
  const lastTask = taskEvents[taskEvents.length - 1];
  for (const te of taskEvents) {
    if (!(delivered && te === lastTask)) te.event.superseded = true;
  }
}

/** Finalize an escalation result: mark superseded legs, then return it. */
function complete(result: EscalationResult): EscalationResult {
  markSupersededLegs(result.events, result.final_action);
  return result;
}

/**
 * P6 §4: escalation-depth difficulty from the review stage + structural action.
 * TODO(P6-1b): token-length fallback when stage is 0 — wire tokens_in from the task leg.
 */
export function deriveOutcomeDifficulty(stage: number, action: OutcomeAction): DifficultyBucket {
  if (action === 'escalate' || action === 'give_back') return 'hard';
  if (action === 'rework') return 'moderate';
  return stage === 0 ? 'easy' : 'moderate';
}

/**
 * Run a task with quality-driven escalation. See the module banner. Pure over its
 * injected deps; bounded by maxReworks (default 1) + maxEscalations (default 1).
 */
export async function runWithEscalation(
  request: RunRequest,
  ctx: RouteContext,
  policy: Policy,
  deps: EscalationDeps,
  opts: EscalationOptions = {},
): Promise<EscalationResult> {
  const maxReworks = opts.maxReworks ?? 1;
  const maxEscalations = opts.maxEscalations ?? 1;
  const minCapabilityDelta = opts.minCapabilityDelta ?? 0.15;
  const task: Task = {
    category: request.category,
    ...(request.difficulty ? { difficulty: request.difficulty } : {}),
  };
  const events: EscalationEvent[] = [];

  // A request.policyContext overrides ctx.policyContext (as runTask does). Use the
  // EFFECTIVE context for manager + target selection and every re-run, so a
  // sensitive/private request can't pick a manager/target the policy would block.
  const effectiveCtx: RouteContext = request.policyContext
    ? { ...ctx, policyContext: request.policyContext }
    : ctx;
  const candidates = opts.candidates ?? effectiveCtx.lanes;

  const task_id = request.task_id ?? deps.newId();
  let attempt = request.attempt ?? 0;

  // Initial offload.
  let current = await runTask({ ...request, task_id, attempt }, effectiveCtx, policy, deps);
  for (const e of current.events) events.push({ kind: 'task', event: e });
  let subject = effectiveCtx.lanes.find((l) => l.id === current.laneId);

  // Status gate: review ONLY an ok, non-native, non-empty offload. Anything else
  // (native/host, failed, blocked, empty) is NOT a quality signal — return it as
  // produced (the adapter maps native/failed to its existing directives).
  const resultReviewable = (r: RunResult): boolean =>
    r.status === 'ok' && r.native !== true && typeof r.resultText === 'string' && r.resultText.trim() !== '';

  if (!resultReviewable(current) || subject === undefined) {
    return complete({ final_action: 'accept', subjectLaneId: current.laneId, result: current, events });
  }
  // `subject` is narrowed to Lane here; keep a Lane-typed handle across the loop.
  let subjectLane: Lane = subject;

  const counters = { reworks: 0, escalations: 0 };
  // ≤ maxReworks + maxEscalations review rounds; the +1 is a hard safety bound.
  for (let round = 0; round < maxReworks + maxEscalations + 1; round++) {
    const output = current.resultText as string;
    const reviewedAttempt = attempt;
    const stage = counters.reworks + counters.escalations; // 0 = initial review

    const manager = selectReviewManager(candidates, subjectLane, request.category, effectiveCtx, policy);
    const unavailable = (reason: string): EscalationResult =>
      complete(
        stage === 0
          ? { final_action: 'review_unavailable', reason, subjectLaneId: subjectLane.id, result: current, events }
          : { final_action: 'give_back', reason: `${reason} (after a leg)`, subjectLaneId: subjectLane.id, result: current, events },
      );
    if (!manager) return unavailable('no eligible manager');

    let raw: string;
    try {
      // Review the FULL subtask the lane saw (instruction + attachments), so the
      // gate never judges attachment-backed work on partial context. The manager
      // is trusted (sees content).
      raw = await deps.runManager(manager, buildOutputReviewPrompt(combinedText(request.instruction, request.attachments), output));
    } catch {
      return unavailable('manager call failed');
    }
    const verdict = parseManagerVerdictStrict(raw);
    if (!verdict) return unavailable('manager verdict unparseable');

    // Decide the structural action, then downgrade per lane constraints.
    let action = escalationDecision(verdict, counters, { maxReworks, maxEscalations });
    if (action === 'rework' && !isMarginalFree(subjectLane)) {
      // A metered subject can't be reworked free ⇒ skip straight to escalate/give_back.
      action = escalationDecision(verdict, { reworks: maxReworks, escalations: counters.escalations }, { maxReworks, maxEscalations });
    }
    let target: Lane | null = null;
    if (action === 'escalate') {
      // P6 §4: an escalated leg has PROVEN hard (same semantics as the recorded
      // outcome's difficulty below), so rank targets on their hard-cell record.
      const escTask: Task = { ...task, difficulty: deriveOutcomeDifficulty(stage, action) };
      target = selectEscalationTarget(subjectLane, candidates, escTask, effectiveCtx, policy, {
        minDelta: minCapabilityDelta,
        excludeIds: [manager.id],
      });
      if (!target) action = 'give_back';
    }

    // Record a content-free outcome event tagged with the action this review caused.
    const notes = raw.trim() === '' ? undefined : raw;
    const reviewRes = await review(
      { task_id, attempt: reviewedAttempt, category: request.category, content: output, subjectLane },
      { managerLane: manager, runManagerReview: async () => (notes ? { verdict, notes } : { verdict }), newId: deps.newId },
    );
    const outcome: OutcomeEventInput = {
      ...reviewRes.event,
      action_taken: action,
      difficulty: deriveOutcomeDifficulty(stage, action),
    };
    if (target) outcome.target_lane_id = target.id;
    events.push({ kind: 'outcome', event: outcome });

    if (action === 'accept') {
      const final_action: EscalationFinalAction =
        counters.escalations > 0 ? 'accept_after_escalation' : counters.reworks > 0 ? 'accept_after_rework' : 'accept';
      return complete({ final_action, verdict, ...(notes ? { notes } : {}), subjectLaneId: subjectLane.id, result: current, events });
    }
    if (action === 'give_back') {
      return complete({ final_action: 'give_back', verdict, ...(notes ? { notes } : {}), subjectLaneId: subjectLane.id, result: current, events });
    }

    // rework (same lane) or escalate (to target): re-run with the notes attached.
    const nextLane: Lane = action === 'escalate' ? (target as Lane) : subjectLane;
    attempt += 1;
    const reRun = await runTask(
      { ...request, task_id, attempt, instruction: instructionWithNotes(request.instruction, notes) },
      { ...effectiveCtx, lanes: [nextLane] },
      policy,
      deps,
    );
    for (const e of reRun.events) events.push({ kind: 'task', event: e });
    if (action === 'escalate') counters.escalations += 1;
    else counters.reworks += 1;

    // A non-reviewable re-run leg is never silently accepted ⇒ terminal give_back.
    if (!resultReviewable(reRun)) {
      return complete({
        final_action: 'give_back',
        reason: `${action} leg produced no reviewable output`,
        subjectLaneId: nextLane.id,
        result: reRun,
        events,
      });
    }
    current = reRun;
    subjectLane = nextLane; // after escalation the target becomes the new subject (re-reviewed independently)
  }

  return complete({ final_action: 'give_back', reason: 'escalation budget exhausted', subjectLaneId: subjectLane.id, result: current, events });
}
