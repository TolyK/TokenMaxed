/**
 * SETUP-1: the lane confirmation summary shown by /tokenmaxed:setup — every
 * configured lane with its model (resolved if `@latest`), trust/permissions, role,
 * and availability, so the user can see exactly what each lane may do and run.
 *
 * PURE (no core/node, no I/O): `setup.ts` builds the rows (it has the registry +
 * core selectors); this module only types them + maps trust→permission + renders.
 * So tools.ts can render setup output without a runtime core import.
 */

import type { Lane } from '@tokenmaxed/core';

/** One row of the setup lane summary (already-derived, content-free). */
export interface LaneSetupRow {
  id: string;
  kind: Lane['kind'];
  /** Concrete model id (an `@latest` alias resolved via the price table). */
  model: string;
  /** The raw `model` when it differs from `model` (i.e. an unresolved/resolved alias). */
  rawModel?: string;
  trustMode: Lane['trust_mode'];
  /** Billing model (how the user pays). For `api` lanes this is USER-ASSERTED, never
   * inferred — setup asks subscription (flat token) vs metered (pay-per-token). */
  costBasis: Lane['costBasis'];
  executionMode: 'answer-only' | 'agentic';
  /** 'reviewer' = the lane the host-turn review would use now; else manager-eligibility. */
  role: 'active-reviewer' | 'manager-eligible' | 'none';
  /** Can it run right now (CLI installed / local server up / BYOK key present)? */
  available: boolean;
  /** Declared per-category capability scores (the user's config), for transparency. */
  capability?: Partial<Record<string, number>>;
}

/**
 * What a lane is PERMITTED to receive/do, by trust mode — with the real qualifiers so
 * the summary never overstates access. (Egress for reader/worker/full-api is still
 * gated at run time; this describes the ceiling the trust mode sets.)
 */
export function permissionFor(trustMode: Lane['trust_mode'], executionMode: 'answer-only' | 'agentic'): string {
  switch (trustMode) {
    case 'full':
      return executionMode === 'agentic'
        ? 'repo + tools, may edit files / run commands (agentic)'
        : 'repo + tools, answer-only';
    case 'reader':
      return 'repo-READ only (no secrets/shell/tools) — needs gate + TOKENMAXED_READER_EGRESS + repo_read_attestation + policy allow';
    case 'worker':
      return 'minimized, scrubbed, NO repo/tools — needs the safety gate';
    case 'blocked':
      return 'never selected (opt-in: change trust_mode)';
    default:
      return String(trustMode);
  }
}

const ROLE_LABEL: Record<LaneSetupRow['role'], string> = {
  'active-reviewer': 'reviewer (active)',
  'manager-eligible': 'manager-eligible',
  none: '—',
};

/** Render the lane rows as human lines for /tokenmaxed:setup. Pure (rows → strings). */
export function formatLaneSetup(rows: readonly LaneSetupRow[]): string[] {
  if (rows.length === 0) return ['  (no lanes configured)'];
  const lines: string[] = ['Lanes (what each may see/do, and whether it can run now):'];
  let anyApi = false;
  for (const r of rows) {
    const model = r.rawModel && r.rawModel !== r.model ? `${r.rawModel} → ${r.model}` : r.model;
    const caps = r.capability && Object.keys(r.capability).length > 0
      ? ' · caps ' + Object.entries(r.capability).map(([c, v]) => `${c}=${v}`).join(',')
      : '';
    // Surface billing so the user can confirm it — and flag API lanes, whose costBasis
    // is the user's plan (subscription token vs metered), never inferred from "api".
    const billing = r.kind === 'api' ? ` · billing=${r.costBasis} (confirm: subscription vs metered)` : ` · billing=${r.costBasis}`;
    if (r.kind === 'api') anyApi = true;
    lines.push(
      `  • ${r.id} [${r.kind}] ${model} · trust=${r.trustMode} → ${permissionFor(r.trustMode, r.executionMode)}` +
        `${billing} · role=${ROLE_LABEL[r.role]} · ${r.available ? 'available' : 'unavailable now'}${caps}`,
    );
  }
  if (anyApi) {
    lines.push(
      '  ⓘ For each api lane, confirm billing: a flat-rate subscription token (costBasis: subscription, ' +
        'treated as $0 and preferred) or pay-per-token (costBasis: metered). TokenMaxed never assumes — set it per YOUR plan.',
    );
  }
  return lines;
}
