/**
 * The append-only event ledger: schema, content-free (de)serialization, and
 * pure aggregations. No I/O — the JSONL file read/append lives in the Node
 * adapter (`./node.ts`).
 *
 * Four invariants make a later web dashboard a pure add-on, not a rewrite:
 *  1. **Content-free.** Events carry only integers, enums, labels, and model
 *     ids — never prompt/code/path text. `serializeEvent` writes ONLY the
 *     allowlisted fields, so nothing else can ever reach the ledger (or, later,
 *     a sync endpoint).
 *  2. **Append-only source of truth.** Every executed task appends one line.
 *  3. **Stable id + monotonic seq.** `id` is globally unique (idempotent upsert
 *     later); `seq` is a per-ledger cursor (resumable sync later).
 *  4. **Derived stats.** `summarize`/`tokenStats` are pure over the events, so
 *     the CLI and a future dashboard agree by construction.
 */

import { aggregateSavings } from './price.ts';
import type { CostPrimitives, SavingsSummary } from './price.ts';
import { TASK_CATEGORIES } from './types.ts';
import type { TaskCategory } from './types.ts';

/** Outcome of the policy gate for a task. v0 only ever emits `allow`. */
export type PolicyVerdict = 'allow' | 'block' | 'force-trusted';

const VERDICTS: readonly PolicyVerdict[] = ['allow', 'block', 'force-trusted'];

/** What a caller provides for a completed task; the ledger assigns id/seq/ts. */
export interface TaskEventInput {
  category: TaskCategory;
  laneId: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  /** true ⇒ usage was heuristically estimated; false ⇒ reported by the lane. */
  tokens_estimated: boolean;
  actual_cost: number;
  frontier_cost: number;
  metered_spent: number;
  frontier_avoided: number;
  metered_avoided: number;
  policy_verdict: PolicyVerdict;
}

/** A persisted task event: the input plus ledger-assigned identity/ordering. */
export interface TaskEvent extends TaskEventInput {
  /** Globally-unique id (stable across a future sync; idempotent upsert key). */
  id: string;
  /** Monotonic per-ledger sequence number (a resumable sync cursor). */
  seq: number;
  /** ISO-8601 timestamp. */
  ts: string;
}

/**
 * The exact, ordered set of fields a ledger line may contain. This allowlist is
 * the content-free guarantee: `serializeEvent` emits these and nothing else.
 */
export const EVENT_FIELDS = [
  'id',
  'seq',
  'ts',
  'category',
  'laneId',
  'model',
  'tokens_in',
  'tokens_out',
  'tokens_estimated',
  'actual_cost',
  'frontier_cost',
  'metered_spent',
  'frontier_avoided',
  'metered_avoided',
  'policy_verdict',
] as const satisfies readonly (keyof TaskEvent)[];

/** Raised for a malformed ledger line or an invalid event input. */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LedgerError(`${where} must be a non-empty string.`);
  }
  return value;
}

function requireIsoTimestamp(value: unknown, where: string): string {
  const s = requireString(value, where);
  if (Number.isNaN(Date.parse(s))) {
    throw new LedgerError(`${where} must be a valid ISO-8601 timestamp (got ${JSON.stringify(value)}).`);
  }
  return s;
}

function requireNonNegativeNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new LedgerError(`${where} must be a finite number >= 0 (got ${JSON.stringify(value)}).`);
  }
  return value;
}

function requireNonNegativeInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new LedgerError(`${where} must be a non-negative integer (got ${JSON.stringify(value)}).`);
  }
  return value;
}

function requireBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') {
    throw new LedgerError(`${where} must be a boolean (got ${JSON.stringify(value)}).`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new LedgerError(`${where} must be one of: ${allowed.join(', ')} (got ${JSON.stringify(value)}).`);
  }
  return value as T;
}

/**
 * Validate and normalize a caller-provided event input (drops any extra fields).
 *
 * Costs/spend come from non-negative price math and must be >= 0. The avoided
 * amounts are **derived canonically** here — `frontier_avoided = frontier_cost −
 * actual_cost` and `metered_avoided = frontier_cost − metered_spent` — rather
 * than trusted from the input, so an inconsistent caller can never persist a
 * value that would permanently skew savings in this append-only ledger. (Avoided
 * amounts may be negative when a lane costs more than the frontier baseline.)
 */
export function validateEventInput(input: TaskEventInput): TaskEventInput {
  const actual_cost = requireNonNegativeNumber(input.actual_cost, 'event.actual_cost');
  const frontier_cost = requireNonNegativeNumber(input.frontier_cost, 'event.frontier_cost');
  const metered_spent = requireNonNegativeNumber(input.metered_spent, 'event.metered_spent');
  return {
    category: requireEnum(input.category, TASK_CATEGORIES, 'event.category'),
    laneId: requireString(input.laneId, 'event.laneId'),
    model: requireString(input.model, 'event.model'),
    tokens_in: requireNonNegativeInt(input.tokens_in, 'event.tokens_in'),
    tokens_out: requireNonNegativeInt(input.tokens_out, 'event.tokens_out'),
    tokens_estimated: requireBoolean(input.tokens_estimated, 'event.tokens_estimated'),
    actual_cost,
    frontier_cost,
    metered_spent,
    frontier_avoided: frontier_cost - actual_cost,
    metered_avoided: frontier_cost - metered_spent,
    policy_verdict: requireEnum(input.policy_verdict, VERDICTS, 'event.policy_verdict'),
  };
}

/** Serialize an event to a single JSONL line containing ONLY the allowlisted fields. */
export function serializeEvent(event: TaskEvent): string {
  const record: Record<string, unknown> = {};
  for (const field of EVENT_FIELDS) {
    record[field] = event[field];
  }
  return JSON.stringify(record);
}

/** Parse and validate one ledger record into a {@link TaskEvent}. */
export function parseEvent(obj: unknown): TaskEvent {
  if (!isPlainObject(obj)) {
    throw new LedgerError('Ledger record must be a JSON object.');
  }
  const input = validateEventInput(obj as unknown as TaskEventInput);
  return {
    id: requireString(obj.id, 'event.id'),
    seq: requireNonNegativeInt(obj.seq, 'event.seq'),
    ts: requireIsoTimestamp(obj.ts, 'event.ts'),
    ...input,
  };
}

/**
 * Events at or after `sinceIso` (all if omitted). Timestamps are compared as
 * parsed instants, not lexicographically, so any valid ISO cutoff works —
 * including offsets or a missing-milliseconds form that would mis-sort as text.
 */
export function filterEventsSince(events: readonly TaskEvent[], sinceIso?: string): TaskEvent[] {
  if (sinceIso === undefined) return [...events];
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) {
    throw new LedgerError(`filterEventsSince: invalid ISO timestamp ${JSON.stringify(sinceIso)}.`);
  }
  return events.filter((e) => Date.parse(e.ts) >= since);
}

/** Per-period dollar + savings summary over a set of events. */
export interface LedgerSummary {
  events: number;
  /** Canonical savings (totals + frontier/metered percentages) from price.ts. */
  savings: SavingsSummary;
  /** Σ actual_cost across the events. */
  actual_cost: number;
  /** Event count per lane id. */
  laneMix: Record<string, number>;
  /** Number of events whose policy verdict was `block`. */
  blockCount: number;
}

/** Summarize events into dollars, the canonical percentages, lane mix, and block count. */
export function summarize(events: readonly TaskEvent[]): LedgerSummary {
  const savings = aggregateSavings(events as readonly CostPrimitives[]);
  let actual_cost = 0;
  let blockCount = 0;
  const laneMix: Record<string, number> = Object.create(null);
  for (const e of events) {
    actual_cost += e.actual_cost;
    if (e.policy_verdict === 'block') blockCount += 1;
    laneMix[e.laneId] = (laneMix[e.laneId] ?? 0) + 1;
  }
  return { events: events.length, savings, actual_cost, laneMix, blockCount };
}

/** in/out/total token counts, split into estimated vs reported. */
export interface TokenBucket {
  in: number;
  out: number;
  total: number;
  estimated: { in: number; out: number; total: number };
  reported: { in: number; out: number; total: number };
}

/** A {@link TokenBucket} plus the number of events that contributed to it. */
export interface TokenGroup extends TokenBucket {
  events: number;
}

/** Overall + per-model + per-lane token usage. */
export interface TokenStats {
  total: TokenBucket;
  byModel: Record<string, TokenGroup>;
  byLane: Record<string, TokenGroup>;
}

function emptyBucket(): TokenBucket {
  return {
    in: 0,
    out: 0,
    total: 0,
    estimated: { in: 0, out: 0, total: 0 },
    reported: { in: 0, out: 0, total: 0 },
  };
}

function addToBucket(b: TokenBucket, e: TaskEvent): void {
  b.in += e.tokens_in;
  b.out += e.tokens_out;
  b.total += e.tokens_in + e.tokens_out;
  const sub = e.tokens_estimated ? b.estimated : b.reported;
  sub.in += e.tokens_in;
  sub.out += e.tokens_out;
  sub.total += e.tokens_in + e.tokens_out;
}

function group(map: Record<string, TokenGroup>, key: string, e: TaskEvent): void {
  let g = map[key];
  if (!g) {
    g = { ...emptyBucket(), events: 0 };
    map[key] = g;
  }
  addToBucket(g, e);
  g.events += 1;
}

/**
 * Pure token usage stats over events: overall, per model, and per lane. Includes
 * $0 local lanes (token usage is independent of cost). Invariants hold by
 * construction: `estimated.total + reported.total === total`, and the sum over
 * `byModel` (and over `byLane`) equals `total`.
 */
export function tokenStats(events: readonly TaskEvent[]): TokenStats {
  const total = emptyBucket();
  const byModel: Record<string, TokenGroup> = Object.create(null);
  const byLane: Record<string, TokenGroup> = Object.create(null);
  for (const e of events) {
    addToBucket(total, e);
    group(byModel, e.model, e);
    group(byLane, e.laneId, e);
  }
  return { total, byModel, byLane };
}
