/**
 * SETUP-1 B: detect when the configured lane set CHANGES, so /tokenmaxed:setup can
 * re-show the lane confirmation (and the session summary can hint to re-review).
 *
 * Pure fingerprint + a versioned, project-scoped "last reviewed" state file. The
 * fingerprint is an ordered, canonical hash over the lane-config fields that affect
 * what a lane RUNS, WHERE content goes, and its displayed permissions/role — so a real
 * config edit is caught, while price-table movement / availability / env toggles are
 * NOT (those are surfaced elsewhere). Lane ORDER matters (it decides the active
 * reviewer). Best-effort I/O — a review-reminder is non-critical, never throws.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Lane } from '@tokenmaxed/core';

const STATE_VERSION = 1;

/** Canonicalize one lane to the fields the fingerprint covers, in a FIXED key order. */
function canonicalLane(l: Lane): Record<string, unknown> {
  // Fixed insertion order ⇒ canonical JSON regardless of the source object's key order.
  return {
    id: l.id,
    kind: l.kind,
    model: l.model, // RAW (an @latest alias is config; price-table resolution is not)
    model_family: l.model_family ?? null,
    trust_mode: l.trust_mode,
    costBasis: l.costBasis,
    provenance: l.provenance,
    jurisdiction: l.jurisdiction,
    native: l.native ?? false,
    manager_allowed: l.manager_allowed ?? false,
    attestation: l.attestation ?? false,
    repo_read_attestation: l.repo_read_attestation ?? false,
    execution_mode: l.execution_mode ?? 'answer-only',
    roles: [...(l.roles ?? [])].sort(), // a role SET — order-insensitive, sort for stability
    command: l.command ?? null,
    args: l.args ?? null, // CLI arg ORDER is significant — preserve it
    endpoint: l.endpoint ?? null,
    authHandle: l.authHandle ?? null,
    capability: sortedCapability(l.capability),
  };
}

/** Capability map with keys sorted (value-stable, key-order-independent). */
function sortedCapability(cap: Lane['capability']): Record<string, number> | null {
  if (!cap) return null;
  const out: Record<string, number> = {};
  for (const k of Object.keys(cap).sort()) out[k] = cap[k as keyof typeof cap] as number;
  return out;
}

/**
 * A stable, ORDER-SENSITIVE fingerprint of the lane set. Same config ⇒ same hash;
 * adding/removing/reordering a lane or editing any covered field ⇒ a new hash.
 */
export function laneSetFingerprint(lanes: readonly Lane[]): string {
  const canonical = lanes.map(canonicalLane); // array order preserved
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Per-project "last reviewed" fingerprint store. */
export interface LaneReviewState {
  version: number;
  byProject: Record<string, { fingerprint: string }>;
}

export function emptyLaneReviewState(): LaneReviewState {
  return { version: STATE_VERSION, byProject: Object.create(null) };
}

/** Coerce arbitrary parsed JSON into a clean state (wrong version / shape ⇒ empty). */
export function coerceLaneReviewState(raw: unknown): LaneReviewState {
  if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== STATE_VERSION) return emptyLaneReviewState();
  const by = (raw as { byProject?: unknown }).byProject;
  if (!by || typeof by !== 'object' || Array.isArray(by)) return emptyLaneReviewState();
  const out = emptyLaneReviewState();
  for (const [key, v] of Object.entries(by as Record<string, unknown>)) {
    const fp = (v as { fingerprint?: unknown })?.fingerprint;
    if (typeof fp === 'string' && fp !== '') out.byProject[key] = { fingerprint: fp };
  }
  return out;
}

export function readLaneReviewState(path: string): LaneReviewState {
  try {
    return existsSync(path) ? coerceLaneReviewState(JSON.parse(readFileSync(path, 'utf8'))) : emptyLaneReviewState();
  } catch {
    return emptyLaneReviewState();
  }
}

export function writeLaneReviewState(path: string, state: LaneReviewState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {
    /* non-critical */
  }
}

/** True when this project has never recorded a fingerprint, or it differs from `fingerprint`. */
export function isLanesChanged(state: LaneReviewState, projectKey: string, fingerprint: string): boolean {
  const e = Object.hasOwn(state.byProject, projectKey) ? state.byProject[projectKey] : undefined;
  return !e || e.fingerprint !== fingerprint;
}

/** Return a NEW state with `projectKey` marked as reviewed at `fingerprint`. */
export function markLanesSeen(state: LaneReviewState, projectKey: string, fingerprint: string): LaneReviewState {
  const next = emptyLaneReviewState();
  Object.assign(next.byProject, state.byProject);
  next.byProject[projectKey] = { fingerprint };
  return next;
}
