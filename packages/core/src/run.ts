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
import { minimize } from './minimize.ts';
import type { MinimizedAttachment, SecretScanner } from './minimize.ts';
import { routeDecide } from './route.ts';
import { resolveUsage, usageFromReported } from './usage.ts';
import type { RawUsage, ResolvedUsage } from './usage.ts';
import type { SafeUntrustedEnvelope, UntrustedLaneDTO } from './boundary.ts';
import type { TaskEventInput, TaskStatus } from './ledger.ts';
import type { Lane, Policy, PolicyContext, RouteContext, RouteDecision, TaskCategory } from './types.ts';

/** A unit of work to run (the content the lane needs, beyond the routing category). */
export interface RunRequest {
  /** Logical task id; one is generated if absent (groups retries/reassignments). */
  task_id?: string;
  category: TaskCategory;
  /** The scoped instruction to perform. */
  instruction: string;
  attachments?: MinimizedAttachment[];
  policyContext?: PolicyContext;
}

/** What a trusted-lane executor returns. `native: true` means "the host did it". */
export interface TrustedExecResult {
  resultText: string;
  reported?: RawUsage;
  native?: boolean;
}

/** What an untrusted-lane executor returns (content-free error on failure). */
export interface UntrustedExecResultLite {
  ok: boolean;
  resultText?: string;
  reported?: RawUsage;
  error?: string;
}

/** Injected dependencies (all I/O). */
export interface RunDeps {
  executeTrusted: (lane: Lane, instruction: string, attachments?: MinimizedAttachment[]) => Promise<TrustedExecResult>;
  executeUntrusted: (env: SafeUntrustedEnvelope) => Promise<UntrustedExecResultLite>;
  /** Resolve a worker lane to its narrow egress DTO (endpoint/authHandle from config). */
  untrustedLaneDTO: (lane: Lane) => UntrustedLaneDTO;
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
  /** Content-free task events to append to the ledger (attempt records). */
  events: TaskEventInput[];
}

const ZERO_USAGE: ResolvedUsage = { tokens_in: 0, tokens_out: 0, tokens_estimated: true };

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
    decision = routeDecide({ category: request.category }, effectiveCtx, policy);
  } catch {
    return { laneId: 'native', status: 'ok', native: true, events: [] };
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
      attempt: 0,
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
        // The host performed it — not recorded (unobservable usage; never lie).
        return { decision, laneId: lane.id, status: 'ok', native: true, resultText: r.resultText, events: [] };
      }
      const usage = resolveUsage({
        reported: r.reported,
        promptText: combinedText(request.instruction, request.attachments),
        resultText: r.resultText,
      });
      return { decision, laneId: lane.id, status: 'ok', resultText: r.resultText, events: [event('ok', usage)] };
    } catch {
      return { decision, laneId: lane.id, status: 'failed', native: true, events: [event('failed', ZERO_USAGE)] };
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
    return { decision, laneId: lane.id, status: 'blocked', native: true, events: [event('blocked', ZERO_USAGE)] };
  }

  try {
    const env: SafeUntrustedEnvelope = { payload: min.payload, lane: deps.untrustedLaneDTO(lane) };
    const promptText = combinedText(min.payload.instruction, min.payload.attachments);
    const r = await deps.executeUntrusted(env);
    if (!r.ok) {
      // Preserve any spend the lane reported before failing (even partial), rather
      // than estimating — so failed metered attempts are never under-reported.
      const usage = r.reported ? usageFromReported(r.reported) : ZERO_USAGE;
      return { decision, laneId: lane.id, status: 'failed', native: true, events: [event('failed', usage)] };
    }
    const usage = resolveUsage({ reported: r.reported, promptText, resultText: r.resultText });
    return { decision, laneId: lane.id, status: 'ok', resultText: r.resultText, events: [event('ok', usage)] };
  } catch {
    return { decision, laneId: lane.id, status: 'failed', native: true, events: [event('failed', ZERO_USAGE)] };
  }
}
