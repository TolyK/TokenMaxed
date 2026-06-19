/**
 * Rankings-sourced capability PRIOR overlay (separate from F-1 observed).
 * Pure, no I/O: resolves the declared-prior slot from local config + optional
 * cached rankings snapshot data. Never mutates {@link Lane.capability}.
 */

import { createHash } from 'node:crypto';

import { parseModelAlias, resolveLaneModel } from './model-freshness.ts';
import type { PriceTable } from './price.ts';
import type {
  CapabilityPriorEvidence,
  CapabilityPriorOverlay,
  Lane,
  ResolvedPrior,
  TaskCategory,
} from './types.ts';
import { TASK_CATEGORIES } from './types.ts';

/** Mirrors {@link DEFAULT_CAPABILITY} in route.ts (duplicated to avoid a circular import). */
const DEFAULT_CAPABILITY = 0.5;

/** Mirrors {@link DEFAULT_PRIOR_STRENGTH} in route.ts (duplicated to avoid a circular import). */
const DEFAULT_PRIOR_STRENGTH = 8;

/**
 * Maximum prior movement allowed per rankings refresh/version. The overlay may
 * move a lane's accepted prior at most ±MAX_PRIOR_DELTA from the previously-
 * accepted value (or the first-acceptance baseline). Clamped values set
 * {@link ResolvedPrior.clamped}.
 */
export const MAX_PRIOR_DELTA = 0.2;

/** Effective shrinkage strength (k) by rankings confidence. Low ⇒ F-1 overrides faster. */
export const PRIOR_STRENGTH_BY_CONFIDENCE = {
  low: 4,
  moderate: 6,
  high: DEFAULT_PRIOR_STRENGTH,
} as const satisfies Record<CapabilityPriorEvidence['confidence'], number>;

/** Map rankings confidence to shrinkage prior strength (pseudo-count k). */
export function priorStrengthFromConfidence(confidence: CapabilityPriorEvidence['confidence']): number {
  return PRIOR_STRENGTH_BY_CONFIDENCE[confidence];
}

/** Options for {@link resolvedPriorFor}. */
export interface ResolvedPriorOptions {
  /** When true, stale-feed rule: no upward movement from the reference prior. */
  stale?: boolean;
  /** Previously-accepted prior per lane×category for the ±Δ cap. */
  accepted?: Record<string, Partial<Record<TaskCategory, number>>>;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Hand-set capability for a category, else {@link DEFAULT_CAPABILITY}. */
function localFallbackCapability(lane: Lane, category: TaskCategory): number {
  const declared = lane.capability?.[category];
  return clamp01(declared ?? DEFAULT_CAPABILITY);
}

function isOptOut(lane: Lane, category: TaskCategory): boolean {
  return lane.capability?.[category] === 0;
}

/**
 * Apply the per-refresh ±Δ cap and the stale zero-upward rule to a proposed
 * overlay prior. `reference` is the previously-accepted value, or the
 * first-acceptance baseline when absent.
 */
export function clampOverlayPrior(
  proposed: number,
  reference: number,
  stale: boolean,
): { value: number; clamped: boolean } {
  const raw = clamp01(proposed);
  const ref = clamp01(reference);
  let value = raw;
  let clamped = false;

  if (stale && value > ref) {
    value = ref;
    clamped = true;
  }

  const minAllowed = ref - MAX_PRIOR_DELTA;
  const maxAllowed = stale ? ref : ref + MAX_PRIOR_DELTA;

  if (value < minAllowed) {
    value = Math.max(0, minAllowed);
    clamped = true;
  } else if (value > maxAllowed) {
    value = maxAllowed;
    clamped = true;
  }

  return { value: clamp01(value), clamped };
}

/**
 * Resolve the rankings prior for a lane×category via the deterministic fallback
 * ladder: opt-out → pinned → overlay (fresh/stale, capped) → hand-set fallback →
 * default. F-1 observed evidence blends on top separately.
 */
export function resolvedPriorFor(
  lane: Lane,
  category: TaskCategory,
  priorOverlay?: CapabilityPriorOverlay,
  opts: ResolvedPriorOptions = {},
): ResolvedPrior {
  if (isOptOut(lane, category)) {
    return { prior: 0, priorStrength: DEFAULT_PRIOR_STRENGTH, provenance: 'opt-out' };
  }

  if (lane.capability_source === 'pinned') {
    return {
      prior: localFallbackCapability(lane, category),
      priorStrength: DEFAULT_PRIOR_STRENGTH,
      provenance: 'pinned',
    };
  }

  const entry = priorOverlay?.[lane.id]?.[category];
  const baseline = localFallbackCapability(lane, category);

  if (entry) {
    const reference = opts.accepted?.[lane.id]?.[category] ?? baseline;
    const { value, clamped } = clampOverlayPrior(entry.value, reference, opts.stale ?? false);
    return {
      prior: value,
      priorStrength: priorStrengthFromConfidence(entry.confidence),
      provenance: opts.stale ? 'overlay-stale' : 'overlay',
      evidence: entry,
      clamped: clamped || undefined,
    };
  }

  if (lane.capability?.[category] !== undefined) {
    return {
      prior: clamp01(lane.capability[category]!),
      priorStrength: DEFAULT_PRIOR_STRENGTH,
      provenance: 'fallback',
      unranked: priorOverlay !== undefined ? true : undefined,
    };
  }

  return {
    prior: DEFAULT_CAPABILITY,
    priorStrength: DEFAULT_PRIOR_STRENGTH,
    provenance: 'default',
    unranked: priorOverlay !== undefined ? true : undefined,
  };
}

/** One rankings row inside a versioned capability snapshot. */
export interface CapabilitySnapshotEntry {
  model: string;
  chart: string;
  category: TaskCategory;
  value: number;
  source: string;
  rank?: number;
  score?: number;
  date: string;
  n?: number;
  confidence: CapabilityPriorEvidence['confidence'];
}

/** Versioned, hash-validated rankings snapshot (Phase-1: schema/hash only). */
export interface CapabilitySnapshot {
  version: number;
  generated: string;
  sources: string[];
  mapping: Partial<Record<TaskCategory, string>>;
  aliases: Record<string, string>;
  entries: CapabilitySnapshotEntry[];
  hash: string;
  _note?: string;
}

export type ValidateSnapshotResult =
  | { valid: true; snapshot: CapabilitySnapshot }
  | { valid: false; reason: string };

const CONFIDENCE_LEVELS = new Set(['low', 'moderate', 'high']);
const CATEGORIES = new Set<string>(TASK_CATEGORIES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Recompute the content hash for a snapshot (all fields except `hash`). */
export function computeSnapshotHash(snapshot: Omit<CapabilitySnapshot, 'hash'> & { hash?: string }): string {
  const { hash: _hash, ...content } = snapshot;
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}

function validateSnapshotEntry(raw: unknown, index: number): CapabilitySnapshotEntry | string {
  if (!isPlainObject(raw)) return `entries[${index}] must be an object`;
  const category = raw.category;
  if (typeof category !== 'string' || !CATEGORIES.has(category)) {
    return `entries[${index}].category is not a known task category`;
  }
  const model = raw.model;
  const chart = raw.chart;
  const source = raw.source;
  const date = raw.date;
  const confidence = raw.confidence;
  const value = raw.value;
  if (typeof model !== 'string' || model === '') return `entries[${index}].model must be a non-empty string`;
  if (typeof chart !== 'string' || chart === '') return `entries[${index}].chart must be a non-empty string`;
  if (typeof source !== 'string' || source === '') return `entries[${index}].source must be a non-empty string`;
  if (typeof date !== 'string' || date === '') return `entries[${index}].date must be a non-empty string`;
  if (typeof confidence !== 'string' || !CONFIDENCE_LEVELS.has(confidence)) {
    return `entries[${index}].confidence must be low, moderate, or high`;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return `entries[${index}].value must be a number in [0, 1]`;
  }
  const entry: CapabilitySnapshotEntry = {
    model,
    chart,
    category: category as TaskCategory,
    value,
    source,
    date,
    confidence: confidence as CapabilityPriorEvidence['confidence'],
  };
  if (raw.rank !== undefined) {
    if (typeof raw.rank !== 'number' || !Number.isFinite(raw.rank) || raw.rank < 1) {
      return `entries[${index}].rank must be a positive number when set`;
    }
    entry.rank = raw.rank;
  }
  if (raw.score !== undefined) {
    if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) {
      return `entries[${index}].score must be a finite number when set`;
    }
    entry.score = raw.score;
  }
  if (raw.n !== undefined) {
    if (typeof raw.n !== 'number' || !Number.isFinite(raw.n) || raw.n < 1) {
      return `entries[${index}].n must be a positive number when set`;
    }
    entry.n = raw.n;
  }
  return entry;
}

/**
 * Validate a loaded rankings snapshot: schema shape + content hash. No network,
 * no signature (Phase 2). Returns the typed snapshot when valid.
 */
export function validateSnapshot(obj: unknown): ValidateSnapshotResult {
  if (!isPlainObject(obj)) return { valid: false, reason: 'snapshot must be an object' };
  const version = obj.version;
  const generated = obj.generated;
  const sources = obj.sources;
  const mapping = obj.mapping;
  const aliases = obj.aliases;
  const entries = obj.entries;
  const hash = obj.hash;

  if (typeof version !== 'number' || !Number.isFinite(version) || version < 1) {
    return { valid: false, reason: 'version must be a positive number' };
  }
  if (typeof generated !== 'string' || generated === '') {
    return { valid: false, reason: 'generated must be a non-empty string' };
  }
  if (!Array.isArray(sources) || sources.some((s) => typeof s !== 'string' || s === '')) {
    return { valid: false, reason: 'sources must be an array of non-empty strings' };
  }
  if (!isPlainObject(mapping)) return { valid: false, reason: 'mapping must be an object' };
  const parsedMapping: Partial<Record<TaskCategory, string>> = {};
  for (const [key, chartId] of Object.entries(mapping)) {
    if (!CATEGORIES.has(key)) return { valid: false, reason: `mapping.${key} is not a known task category` };
    if (typeof chartId !== 'string' || chartId === '') {
      return { valid: false, reason: `mapping.${key} must be a non-empty chart id` };
    }
    parsedMapping[key as TaskCategory] = chartId;
  }
  if (!isPlainObject(aliases)) return { valid: false, reason: 'aliases must be an object' };
  const parsedAliases: Record<string, string> = {};
  for (const [modelId, chartEntryId] of Object.entries(aliases)) {
    if (modelId === '' || typeof chartEntryId !== 'string' || chartEntryId === '') {
      return { valid: false, reason: 'aliases must map non-empty model ids to non-empty chart entry ids' };
    }
    parsedAliases[modelId] = chartEntryId;
  }
  if (!Array.isArray(entries)) return { valid: false, reason: 'entries must be an array' };
  const parsedEntries: CapabilitySnapshotEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const result = validateSnapshotEntry(entries[i], i);
    if (typeof result === 'string') return { valid: false, reason: result };
    parsedEntries.push(result);
  }
  if (typeof hash !== 'string' || hash === '') return { valid: false, reason: 'hash must be a non-empty string' };

  const snapshot: CapabilitySnapshot = {
    version,
    generated,
    sources: [...sources],
    mapping: parsedMapping,
    aliases: parsedAliases,
    entries: parsedEntries,
    hash,
  };
  if (obj._note !== undefined) {
    if (typeof obj._note !== 'string') return { valid: false, reason: '_note must be a string when set' };
    snapshot._note = obj._note;
  }

  const expected = computeSnapshotHash(snapshot);
  if (hash !== expected) {
    return { valid: false, reason: `hash mismatch (expected ${expected}, got ${hash})` };
  }
  return { valid: true, snapshot };
}

/** Options for {@link overlayFromSnapshot}. */
export interface OverlayFromSnapshotOptions {
  /** Price table for resolving `<family>@latest` before alias lookup. */
  priceTable?: PriceTable;
}

export interface OverlayBuildResult {
  overlay: CapabilityPriorOverlay;
  /** Lane×category pairs with no confident chart match (fallback applies). */
  unranked: Array<{ laneId: string; category: TaskCategory }>;
}

function resolveLaneModelId(lane: Lane, priceTable?: PriceTable): string {
  if (priceTable) return resolveLaneModel(lane, priceTable).model;
  const spec = parseModelAlias(lane.model);
  return spec.latest ? lane.model : spec.id;
}

function findSnapshotEntry(
  snapshot: CapabilitySnapshot,
  resolvedModel: string,
  category: TaskCategory,
): CapabilitySnapshotEntry | undefined {
  const chartId = snapshot.mapping[category];
  if (!chartId) return undefined;
  const chartEntryId = snapshot.aliases[resolvedModel];
  if (!chartEntryId) return undefined;
  return snapshot.entries.find((e) => e.category === category && e.chart === chartId && e.model === chartEntryId);
}

function entryToEvidence(entry: CapabilitySnapshotEntry): CapabilityPriorEvidence {
  const evidence: CapabilityPriorEvidence = {
    value: entry.value,
    source: entry.source,
    chart: entry.chart,
    date: entry.date,
    confidence: entry.confidence,
  };
  if (entry.rank !== undefined) evidence.rank = entry.rank;
  if (entry.score !== undefined) evidence.score = entry.score;
  if (entry.n !== undefined) evidence.n = entry.n;
  return evidence;
}

/**
 * Build a {@link CapabilityPriorOverlay} from a validated snapshot and local
 * lanes. Uses the curated `aliases` table only — no fuzzy matching. Unmatched
 * models or unmapped categories are omitted (fallback/unranked).
 */
export function overlayFromSnapshot(
  snapshot: CapabilitySnapshot,
  lanes: readonly Lane[],
  opts: OverlayFromSnapshotOptions = {},
): OverlayBuildResult {
  const overlay: CapabilityPriorOverlay = Object.create(null);
  const unranked: OverlayBuildResult['unranked'] = [];

  for (const lane of lanes) {
    const resolvedModel = resolveLaneModelId(lane, opts.priceTable);
    for (const category of TASK_CATEGORIES) {
      if (!snapshot.mapping[category]) continue;
      const entry = findSnapshotEntry(snapshot, resolvedModel, category);
      if (!entry) {
        unranked.push({ laneId: lane.id, category });
        continue;
      }
      const inner = overlay[lane.id] ?? (overlay[lane.id] = Object.create(null));
      inner[category] = entryToEvidence(entry);
    }
  }

  return { overlay, unranked };
}

/** Build {@link EffectiveCapabilityOptions} from a route context when a prior overlay is present. */
export function priorOptsFromContext(ctx: {
  capabilityPriorStale?: boolean;
  capabilityPriorAccepted?: Record<string, Partial<Record<TaskCategory, number>>>;
}): ResolvedPriorOptions {
  return {
    stale: ctx.capabilityPriorStale,
    accepted: ctx.capabilityPriorAccepted,
  };
}