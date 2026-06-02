/**
 * The untrusted execution boundary (C-4). Pure — the actual network egress lives
 * in the Node adapter (`executeUntrusted` in node.ts).
 *
 * An untrusted lane is reached ONLY through a {@link SafeUntrustedEnvelope}: a
 * genuine {@link MinimizedPayload} plus a NARROW {@link UntrustedLaneDTO}
 * (id/model/endpoint/authHandle only) — never a full `Lane`, repo handle,
 * `TaskContext`, or logger. The outbound request body is built by an allowlist
 * serializer here, so only the minimized payload + sanitized lane metadata can
 * ever go on the wire.
 */

import { isMinimizedPayload } from './minimize.ts';
import type { MinimizedPayload } from './minimize.ts';
import type { Lane } from './types.ts';

/** The minimal lane facts an untrusted executor may see. No repo/ctx/secrets. */
export interface UntrustedLaneDTO {
  id: string;
  model: string;
  /** Full URL to POST to. */
  endpoint: string;
  /** OPAQUE reference to a credential (resolved to a token only at send time); never logged/recorded. */
  authHandle: string;
}

/** The only thing an untrusted executor accepts. */
export interface SafeUntrustedEnvelope {
  payload: MinimizedPayload;
  lane: UntrustedLaneDTO;
}

/** The allowlisted outbound request body — ONLY model + minimized content. */
export interface UntrustedRequestBody {
  model: string;
  messages: { role: 'user'; content: string }[];
}

/**
 * Build the outbound request body for an untrusted lane. Allowlist by
 * construction: only `lane.model` and the minimized payload's text are included —
 * never the lane id, endpoint, authHandle, or any other field.
 */
export function buildUntrustedRequestBody(env: SafeUntrustedEnvelope): UntrustedRequestBody {
  // Enforce the runtime boundary here too (this helper is exported): a spread/
  // cloned payload carries the copyable type brand but is not genuine.
  if (!isMinimizedPayload(env.payload)) {
    throw new Error('buildUntrustedRequestBody: payload was not produced by minimize()');
  }
  const { payload, lane } = env;
  const content = [payload.instruction, ...payload.attachments.map((a) => a.content)].join('\n\n');
  return { model: lane.model, messages: [{ role: 'user', content }] };
}

/**
 * Whether a core-owned, egress-CI-certified untrusted executor exists for a lane.
 * v0: the generic BYOK HTTP executor (kind `api`) passed the egress-envelope CI,
 * so it is certified. This is a CODE property of the executor implementation —
 * NOT a `lanes.yaml` field a user/adapter can set.
 */
export function isExecutorCertified(lane: Lane): boolean {
  return lane.kind === 'api';
}
