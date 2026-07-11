/**
 * P2 DYNAMIC-CAPABILITY — adapter-side loader for the rankings capability-prior
 * snapshot. ONE loading/validation path shared by the server (delegate + preview
 * contexts) and setup/status reporting, so every surface agrees on whether the
 * prior is off / active / errored (no /why-vs-run divergence).
 *
 * OPT-IN (off by default): the bundled seed snapshot carries labeled PLACEHOLDER
 * values, and routing must never move on numbers the user didn't ask for
 * (honesty invariant). Enable with TOKENMAXED_CAPABILITY_PRIOR=true; the global
 * kill-switch (TOKENMAXED_DISABLE) forces it off like every other opt-in.
 *
 * FAIL-OPEN: a missing/unreadable/invalid snapshot never throws and never
 * changes routing — it degrades to declared capabilities and surfaces a one-line
 * warning through setup/status instead.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { overlayFromSnapshot, validateSnapshot } from '@tokenmaxed/core';
import type { CapabilitySnapshot, Lane, PriceTable } from '@tokenmaxed/core';

import type { CapabilityPriorState } from './tools.ts';

/** The validated snapshot itself (read ONCE), before any lane-set overlay build. */
export type CapabilitySnapshotState =
  | { state: 'off' }
  | { state: 'error'; warning: string }
  | { state: 'on'; snapshot: CapabilitySnapshot; stale: boolean };

// Rankings capability-prior seed shipped WITH this package, resolved module-
// relative (same ../ pattern as prices.seed.json — sits next to dist/ in the
// package and next to server/ in the plugin bundle). Reference data only — a
// snapshot can only ever adjust capability SCORES, never trust/enablement, so
// bundling it is not an execution surface (unlike lanes/policy, which stay
// user-owned).
const DEFAULT_CAPABILITY_SNAPSHOT = fileURLToPath(new URL('../capability-snapshot.v1.json', import.meta.url));

/** Snapshots older than this are STALE: the zero-upward-movement rule applies. */
export const MAX_SNAPSHOT_AGE_DAYS = 45;
const MAX_SNAPSHOT_AGE_MS = MAX_SNAPSHOT_AGE_DAYS * 24 * 60 * 60 * 1000;

/** Whether the rankings prior is enabled (opt-in; forced off by the kill-switch). */
export function capabilityPriorEnabled(env: NodeJS.ProcessEnv): boolean {
  const globallyDisabled = env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true';
  return env.TOKENMAXED_CAPABILITY_PRIOR === 'true' && !globallyDisabled;
}

/**
 * Load + validate the snapshot and build the lane-keyed prior overlay for the
 * given lanes. Lanes are expected to be model-RESOLVED already (`@latest` ⇒
 * concrete id) on the routing paths; pass `priceTable` when they may not be
 * (setup reads the raw registry), so `overlayFromSnapshot` can resolve.
 *
 * Never throws: any load/validation failure returns `{ state: 'error' }` with a
 * one-line warning, and routing proceeds on declared capabilities.
 */
/**
 * Read + validate the snapshot FILE once (no overlay build). Callers that need
 * a consistent posture across several lane sets (e.g. the quota-alert overflow
 * plan) capture this once and derive per-set overlays purely from it.
 */
export function loadCapabilitySnapshotState(env: NodeJS.ProcessEnv, opts: { now?: number } = {}): CapabilitySnapshotState {
  if (!capabilityPriorEnabled(env)) return { state: 'off' };
  const path = env.TOKENMAXED_CAPABILITY_SNAPSHOT ?? DEFAULT_CAPABILITY_SNAPSHOT;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { state: 'error', warning: `capability snapshot unreadable (${path}): ${(err as Error).message}` };
  }

  const validated = validateSnapshot(parsed);
  if (!validated.valid) {
    return { state: 'error', warning: `capability snapshot invalid (${path}): ${validated.reason}` };
  }

  const snapshot = validated.snapshot;
  // An unparseable `generated` date counts as stale (conservative: a snapshot of
  // unknown age must not move any prior upward).
  const generatedMs = Date.parse(snapshot.generated);
  const now = opts.now ?? Date.now();
  const stale = !Number.isFinite(generatedMs) || now - generatedMs > MAX_SNAPSHOT_AGE_MS;
  return { state: 'on', snapshot, stale };
}

/** Build the lane-keyed overlay state from an already-loaded snapshot (pure). */
export function priorStateFromSnapshot(
  loaded: CapabilitySnapshotState,
  lanes: readonly Lane[],
  opts: { priceTable?: PriceTable } = {},
): CapabilityPriorState {
  if (loaded.state !== 'on') return loaded;
  const { overlay, unranked } = overlayFromSnapshot(loaded.snapshot, lanes, opts.priceTable ? { priceTable: opts.priceTable } : {});
  return {
    state: 'on',
    overlay,
    stale: loaded.stale,
    meta: {
      source: loaded.snapshot.sources.join(', '),
      generated: loaded.snapshot.generated,
      categories: Object.keys(loaded.snapshot.mapping),
      unrankedCount: unranked.length,
    },
  };
}

export function loadCapabilityPriorState(
  env: NodeJS.ProcessEnv,
  lanes: readonly Lane[],
  opts: { priceTable?: PriceTable; now?: number } = {},
): CapabilityPriorState {
  return priorStateFromSnapshot(loadCapabilitySnapshotState(env, opts), lanes, opts);
}
