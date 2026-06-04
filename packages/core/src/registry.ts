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

import { parseModelAlias } from './model-freshness.ts';
import { declaredCapabilityFor } from './route.ts';
import { TASK_CATEGORIES, TRUST_MODE_ALIASES, TRUST_MODES } from './types.ts';
import type {
  CostBasis,
  ExecutionMode,
  Lane,
  LaneKind,
  LaneRole,
  TaskCategory,
} from './types.ts';

const LANE_KINDS: readonly LaneKind[] = ['cli', 'api', 'local'];
const COST_BASES: readonly CostBasis[] = ['subscription', 'metered', 'local'];
const LANE_ROLES: readonly LaneRole[] = ['manager', 'worker'];
const EXECUTION_MODES: readonly ExecutionMode[] = ['answer-only', 'agentic'];
const CATEGORIES = new Set<string>(TASK_CATEGORIES);

/** Fields a lane entry may declare. Anything else is rejected as a likely typo. */
const ALLOWED_LANE_KEYS = new Set([
  'id',
  'kind',
  'model',
  'model_family',
  'trust_mode',
  'costBasis',
  'provenance',
  'jurisdiction',
  'roles',
  'manager_allowed',
  'execution_mode',
  'attestation',
  'repo_read_attestation',
  'command',
  'args',
  'endpoint',
  'authHandle',
  'native',
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
  const at = (field: string): string => `lanes[${index}] (${id}).${field}`;
  // Normalize deprecated trust-mode aliases (e.g. `monitored` → `reader`) BEFORE
  // enum validation, so old configs keep loading; the canonical value is stored.
  const rawTrust = entry.trust_mode;
  const aliasedTrust =
    typeof rawTrust === 'string' && rawTrust in TRUST_MODE_ALIASES ? TRUST_MODE_ALIASES[rawTrust] : rawTrust;
  const trust_mode = requireEnum(aliasedTrust, TRUST_MODES, at('trust_mode'));
  const lane: Lane = {
    id,
    kind: requireEnum(entry.kind, LANE_KINDS, at('kind')),
    model: requireString(entry.model, at('model')),
    trust_mode,
    costBasis: requireEnum(entry.costBasis, COST_BASES, at('costBasis')),
    provenance: requireString(entry.provenance, at('provenance')),
    jurisdiction: requireString(entry.jurisdiction, at('jurisdiction')),
  };

  if (entry.roles !== undefined) {
    if (!Array.isArray(entry.roles)) {
      throw new LaneConfigError(`${at('roles')} must be an array of: ${LANE_ROLES.join(', ')}.`);
    }
    lane.roles = entry.roles.map((r, i) => requireEnum(r, LANE_ROLES, `${at('roles')}[${i}]`));
  }
  if (entry.manager_allowed !== undefined) {
    if (typeof entry.manager_allowed !== 'boolean') {
      throw new LaneConfigError(`${at('manager_allowed')} must be a boolean.`);
    }
    lane.manager_allowed = entry.manager_allowed;
  }
  if (entry.attestation !== undefined) {
    if (typeof entry.attestation !== 'boolean') {
      throw new LaneConfigError(`${at('attestation')} must be a boolean.`);
    }
    lane.attestation = entry.attestation;
  }
  if (entry.repo_read_attestation !== undefined) {
    if (typeof entry.repo_read_attestation !== 'boolean') {
      throw new LaneConfigError(`${at('repo_read_attestation')} must be a boolean.`);
    }
    // This attestation only has meaning for a reader lane (it authorizes private
    // repo-read egress to that vendor). Reject it on any other tier REGARDLESS of
    // value — even `false` is misleading on a full/worker lane (it has no effect;
    // trust_mode alone controls context), so the field must not appear there.
    if (trust_mode !== 'reader') {
      throw new LaneConfigError(
        `${at('repo_read_attestation')}: only valid on a 'reader' lane (got trust_mode '${trust_mode}').`,
      );
    }
    lane.repo_read_attestation = entry.repo_read_attestation;
  }
  if (entry.execution_mode !== undefined) {
    const mode = requireEnum(entry.execution_mode, EXECUTION_MODES, at('execution_mode'));
    // Invariant: agentic autonomy is only permitted for full-trust lanes.
    if (mode === 'agentic' && trust_mode !== 'full') {
      throw new LaneConfigError(
        `${at('execution_mode')}: 'agentic' is only allowed when trust_mode is 'full' ` +
          `(got trust_mode '${trust_mode}'). Untrusted lanes are never agentic-with-access.`,
      );
    }
    lane.execution_mode = mode;
  }

  if (entry.native !== undefined) {
    if (typeof entry.native !== 'boolean') throw new LaneConfigError(`${at('native')} must be a boolean.`);
    // `native` is the host/do-it-yourself lane — inherently full trust. Reject it
    // on non-full lanes (e.g. a worker+native lane would be contradictory: routing
    // would still send it through the untrusted path).
    if (entry.native && lane.trust_mode !== 'full') {
      throw new LaneConfigError(`${at('native')}: native is only valid on a full-trust lane (got trust_mode '${lane.trust_mode}').`);
    }
    lane.native = entry.native;
  }
  if (entry.model_family !== undefined) lane.model_family = requireString(entry.model_family, at('model_family'));
  if (entry.command !== undefined) lane.command = requireString(entry.command, at('command'));
  if (entry.endpoint !== undefined) lane.endpoint = requireString(entry.endpoint, at('endpoint'));
  if (entry.authHandle !== undefined) lane.authHandle = requireString(entry.authHandle, at('authHandle'));
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== 'string')) {
      throw new LaneConfigError(`${at('args')} must be an array of strings.`);
    }
    lane.args = entry.args as string[];
  }

  const capability = parseCapability(entry.capability, at('capability'));
  if (capability) lane.capability = capability;

  // A SELECTABLE (full/worker/reader), non-native lane must be executable: cli
  // needs a command, api needs an endpoint (local defaults to localhost). Reject
  // at load so an unexecutable lane can never be selected and silently degrade —
  // including `reader` now that it can execute (an endpointless api reader would
  // otherwise win routing then throw in laneToReaderDTO). Only `blocked` may omit
  // executor config.
  const selectable =
    lane.trust_mode === 'full' || lane.trust_mode === 'worker' || lane.trust_mode === 'reader';
  if (selectable && !lane.native) {
    if (lane.kind === 'cli' && lane.command === undefined) {
      throw new LaneConfigError(`${at('command')}: a non-native cli lane requires a command (or set native: true).`);
    }
    if (lane.kind === 'api' && lane.endpoint === undefined) {
      throw new LaneConfigError(`${at('endpoint')}: an api lane requires an endpoint.`);
    }
  }
  // A `<family>@latest` alias is resolved against the price table at routing time.
  // Reject anything ending in "@latest" that isn't a well-formed alias on an api
  // lane: bare "@latest" (empty family stem) would otherwise parse as a concrete id
  // and could reach execution literally; CLI/local lanes pin a concrete model.
  if (lane.model.trim().endsWith('@latest')) {
    if (lane.kind !== 'api') {
      throw new LaneConfigError(`${at('model')}: a "<family>@latest" alias is only supported on api lanes.`);
    }
    if (!parseModelAlias(lane.model).latest) {
      throw new LaneConfigError(`${at('model')}: "@latest" needs a family stem, e.g. "minimax@latest".`);
    }
  }
  return lane;
}

/** Deep-freeze a defensive clone of a lane so neither it nor its capability map can mutate. */
function freezeLane(lane: Lane): Lane {
  const clone: Lane = { ...lane };
  if (clone.capability) clone.capability = Object.freeze({ ...clone.capability });
  if (clone.roles) clone.roles = Object.freeze([...clone.roles]) as Lane['roles'];
  if (clone.args) clone.args = Object.freeze([...clone.args]) as Lane['args'];
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
    return this.lanes.filter((lane) => declaredCapabilityFor(lane, category) > 0);
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
