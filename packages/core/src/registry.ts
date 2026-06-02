/**
 * Lane registry: load and validate the locally-configured lanes.
 *
 * Lane identity and trust live ONLY here, in local config. The hosted registry
 * feed (P1-S3b) may later overlay reference data (prices, capability scores)
 * onto these lanes, but it can never create, enable, or re-trust one.
 *
 * This module is pure (no I/O): it parses and validates lane config from a
 * string. Reading a file is a Node concern and lives in the Node adapter
 * (`./node.ts`, exposed as the `@tokenmaxed/core/node` subpath) so the core
 * barrel never pulls `node:fs` into browser/edge consumers that only route.
 */

import { parse as parseYaml } from 'yaml';

import { capabilityFor } from './route.ts';
import { TASK_CATEGORIES } from './types.ts';
import type { CostBasis, Lane, LaneKind, TaskCategory } from './types.ts';

const LANE_KINDS: readonly LaneKind[] = ['cli', 'api', 'local'];
const TRUSTS: readonly Lane['trust'][] = ['trusted', 'untrusted'];
const COST_BASES: readonly CostBasis[] = ['subscription', 'metered', 'local'];
const CATEGORIES = new Set<string>(TASK_CATEGORIES);

/** Fields a lane entry may declare. Anything else is rejected as a likely typo. */
const ALLOWED_LANE_KEYS = new Set([
  'id',
  'kind',
  'model',
  'trust',
  'costBasis',
  'provenance',
  'jurisdiction',
  'capability',
]);

/** Raised for any malformed or invalid lane configuration, with a clear message. */
export class LaneConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaneConfigError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LaneConfigError(`${where} must be a non-empty string.`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new LaneConfigError(
      `${where} must be one of: ${allowed.join(', ')} (got ${JSON.stringify(value)}).`,
    );
  }
  return value as T;
}

function parseCapability(
  value: unknown,
  where: string,
): Partial<Record<TaskCategory, number>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new LaneConfigError(`${where} must be a mapping of category to a number in [0, 1].`);
  }
  const out: Partial<Record<TaskCategory, number>> = {};
  for (const [category, raw] of Object.entries(value)) {
    if (!CATEGORIES.has(category)) {
      throw new LaneConfigError(
        `${where}.${category} is not a known task category. Valid: ${TASK_CATEGORIES.join(', ')}.`,
      );
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
      throw new LaneConfigError(
        `${where}.${category} must be a number in [0, 1] (got ${JSON.stringify(raw)}).`,
      );
    }
    out[category as TaskCategory] = raw;
  }
  return out;
}

function parseLane(entry: unknown, index: number): Lane {
  const where = `lanes[${index}]`;
  if (!isPlainObject(entry)) {
    throw new LaneConfigError(`${where} must be a mapping.`);
  }
  for (const key of Object.keys(entry)) {
    if (!ALLOWED_LANE_KEYS.has(key)) {
      throw new LaneConfigError(
        `${where} has unknown field "${key}". Allowed: ${[...ALLOWED_LANE_KEYS].join(', ')}.`,
      );
    }
  }
  const id = requireString(entry.id, `${where}.id`);
  const lane: Lane = {
    id,
    kind: requireEnum(entry.kind, LANE_KINDS, `lanes[${index}] (${id}).kind`),
    model: requireString(entry.model, `lanes[${index}] (${id}).model`),
    trust: requireEnum(entry.trust, TRUSTS, `lanes[${index}] (${id}).trust`),
    costBasis: requireEnum(entry.costBasis, COST_BASES, `lanes[${index}] (${id}).costBasis`),
    provenance: requireString(entry.provenance, `lanes[${index}] (${id}).provenance`),
    jurisdiction: requireString(entry.jurisdiction, `lanes[${index}] (${id}).jurisdiction`),
  };
  const capability = parseCapability(entry.capability, `lanes[${index}] (${id}).capability`);
  if (capability) lane.capability = capability;
  return lane;
}

/** Deep-freeze a defensive clone of a lane so neither it nor its capability map can mutate. */
function freezeLane(lane: Lane): Lane {
  const clone: Lane = { ...lane };
  if (clone.capability) clone.capability = Object.freeze({ ...clone.capability });
  return Object.freeze(clone);
}

/** An immutable, validated view over the configured lanes. */
export class LaneRegistry {
  readonly lanes: readonly Lane[];
  readonly #byId: Map<string, Lane>;

  constructor(lanes: Lane[]) {
    // Store deep-frozen clones so a reference obtained via `lanes`/`byId` cannot
    // be mutated to change later candidateLanes()/routeDecide() results.
    const frozen = lanes.map(freezeLane);
    this.lanes = Object.freeze(frozen);
    this.#byId = new Map(frozen.map((lane) => [lane.id, lane]));
  }

  /** Look up a lane by its id. */
  byId(id: string): Lane | undefined {
    return this.#byId.get(id);
  }

  /**
   * Lanes eligible for a task category, in configuration order. A lane is
   * eligible unless it has explicitly opted out by declaring a capability of 0
   * for the category; unspecified categories use the default capability and are
   * therefore eligible. (Trust/API gating is applied later by routing, not here.)
   */
  candidateLanes(category: TaskCategory): Lane[] {
    return this.lanes.filter((lane) => capabilityFor(lane, category) > 0);
  }
}

/** Parse and validate lane configuration from a YAML string. */
export function parseLaneConfig(text: string): LaneRegistry {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new LaneConfigError(`Could not parse lane config as YAML: ${detail}`);
  }
  if (!isPlainObject(doc) || !Array.isArray(doc.lanes)) {
    throw new LaneConfigError('Lane config must be a mapping with a "lanes" array.');
  }
  if (doc.lanes.length === 0) {
    throw new LaneConfigError('Lane config "lanes" array is empty; configure at least one lane.');
  }
  const lanes = doc.lanes.map((entry, i) => parseLane(entry, i));

  const seen = new Set<string>();
  for (const lane of lanes) {
    if (seen.has(lane.id)) {
      throw new LaneConfigError(`Duplicate lane id "${lane.id}"; lane ids must be unique.`);
    }
    seen.add(lane.id);
  }
  return new LaneRegistry(lanes);
}
