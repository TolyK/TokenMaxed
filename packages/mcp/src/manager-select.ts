/**
 * Manager/reviewer lane selection — a PURE module (imports only the pure
 * `@tokenmaxed/core`, never `@tokenmaxed/core/node` or any host I/O). Extracted
 * from host-review.ts so it can be reused by setup, host-turn review, and the
 * summary builder without dragging a runtime core/node import into those callers
 * (which would break tools.ts's no-runtime-import test shape).
 */

import { evaluate, hostAllowsLane, isManagerEligible, isSelectablePreGate, laneAllowedByVerdict } from '@tokenmaxed/core';
import type { Lane, Policy } from '@tokenmaxed/core';

/** The signature of {@link selectManagerLane}, for dependency injection (no static import). */
export type ManagerSelectPort = (
  lanes: readonly Lane[],
  policy: Policy,
  gateReady: boolean,
  available: ReadonlySet<string> | null,
  host?: string,
) => Lane | undefined;

/**
 * The manager lane the review path will actually use, applying ALL the same
 * filters as routing so /tokenmaxed:setup and the review never disagree:
 *  - manager-eligible (full trust + manager_allowed + trusted origin/attestation)
 *  - EXECUTABLE (not the native host — we can't run the host from here)
 *  - gate-selectable (an API manager only once the safety gate is open — egress)
 *  - AVAILABLE to run now (when an availability set is supplied)
 *  - allowed under THIS host (F `hosts:` allowlist; unknown host fails closed)
 *  - not policy-disabled / blocked. The diff IS the user's real code, so egress is
 *    evaluated as the most sensitive context (private + sensitive).
 */
export function selectManagerLane(
  lanes: readonly Lane[],
  policy: Policy,
  gateReady: boolean,
  available: ReadonlySet<string> | null = null,
  host?: string,
): Lane | undefined {
  const disabled = new Set(policy.disabledLaneIds ?? []);
  const reviewContext = { repo_class: 'private' as const, sensitivity: 'sensitive' as const };
  return lanes.find(
    (l) =>
      isManagerEligible(l) &&
      !l.native &&
      // F: a lane with a hosts: allowlist may only review under a listed host
      // (independent filter — the review path must not spawn e.g. the claude
      // binary inside a host framework the user hasn't opted in). Fail closed.
      hostAllowsLane(l, { host }) &&
      isSelectablePreGate(l, gateReady) &&
      !disabled.has(l.id) &&
      (!available || available.has(l.id)) &&
      laneAllowedByVerdict(l, evaluate({ category: 'refactor' }, l, reviewContext, policy).verdict),
  );
}
