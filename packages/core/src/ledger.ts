/**
 * The append-only event ledger: a versioned, content-free discriminated union
 * (`task` | `outcome`), its (de)serialization, and pure aggregations. No I/O —
 * the JSONL file read/append lives in the Node adapter (`./node.ts`).
 *
 * Invariants that make a later web dashboard a pure add-on:
 *  1. **Content-free.** Events carry only integers, enums, labels, ids — never
 *     prompt/code/path text. Serialization writes ONLY allowlisted fields.
 *  2. **Append-only source of truth**; one line per event.
 *  3. **Stable id + monotonic seq** (idempotent/resumable sync later) +
 *     correlation ids (`task_id`/`turn_id`/`review_id`, `attempt`, `parent_task_id`).
 *  4. **Derived stats.** `summarize`/`tokenStats` are pure over the events.
 */

import type { SavingsSummary } from './price.ts';
import { DIFFICULTY_BUCKETS, POLICY_VERDICTS, TASK_CATEGORIES, TRUST_MODES } from './types.ts';
import type { DifficultyBucket, PolicyVerdict, TaskCategory, TrustMode } from './types.ts';

/** Current ledger schema version (stamped on every event). */
export const SCHEMA_VERSION = 2;

// Difficulty bucket lives in types.ts (routing consumes it via Task.difficulty);
// re-exported here so existing `from './ledger.ts'` importers keep working.
export { DIFFICULTY_BUCKETS };
export type { DifficultyBucket };

/**
 * Status of an executed/attempted task. Only `ok` feeds savings claims. `native` is
 * a content-free BREADCRUMB: the task degraded to the host (no lane ran it). It
 * carries zero spend/tokens and is excluded from offloads, blocks, lane mix, and
 * savings by {@link summarize} — it exists only so a silent native degrade is visible.
 */
export type TaskStatus = 'ok' | 'failed' | 'blocked' | 'fallback' | 'native';
const TASK_STATUSES: readonly TaskStatus[] = ['ok', 'failed', 'blocked', 'fallback', 'native'];

/** Why a task degraded to native (host did it). Set ONLY on a `native`-status event. */
export type NativeReason = 'no_route' | 'host_native';
const NATIVE_REASONS: readonly NativeReason[] = ['no_route', 'host_native'];

/** Review verdict (reuses the dogfood scale). */
export type ReviewVerdict = 'pass' | 'needs-rework' | 'fail';
const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['pass', 'needs-rework', 'fail'];

/** Who cast a review verdict. */
export type Voter = 'reviewer_model' | 'user';
const VOTERS: readonly Voter[] = ['reviewer_model', 'user'];

/** What was reviewed: a router-managed task, or a host turn (e.g. Stop-hook diff). */
export type SubjectType = 'router_task' | 'host_turn';
const SUBJECT_TYPES: readonly SubjectType[] = ['router_task', 'host_turn'];

/**
 * The escalation action a review caused (C-13). Mirrors `EscalationAction` in
 * reassign.ts (kept as a local list to avoid a runtime import cycle). Content-free
 * routing metadata — never any task content.
 */
export type OutcomeAction = 'accept' | 'rework' | 'escalate' | 'give_back';
const OUTCOME_ACTIONS: readonly OutcomeAction[] = ['accept', 'rework', 'escalate', 'give_back'];

/** Identity/ordering the ledger assigns to every event. */
interface EventMeta {
  event_type: 'task' | 'outcome';
  schema_version: number;
  /** Globally-unique id (idempotent upsert key for a future sync). */
  id: string;
  /** Monotonic per-ledger sequence (a resumable sync cursor). */
  seq: number;
  /** ISO-8601 timestamp. */
  ts: string;
}

/** What a caller provides for a task event; the ledger assigns the {@link EventMeta}. */
export interface TaskEventInput {
  task_id: string;
  attempt: number;
  parent_task_id?: string;
  category: TaskCategory;
  laneId: string;
  model: string;
  trust_mode: TrustMode;
  provenance: string;
  status: TaskStatus;
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
  /**
   * C-13: true ⇒ this attempt's output was SUPERSEDED (reworked away, rejected
   * before an escalation, or part of a give_back) and never delivered. Its real
   * spend (actual_cost/metered) + tokens still count, but it is EXCLUDED from the
   * savings baseline (a discarded leg is not a saving). Optional; absent ⇒ false.
   */
  superseded?: boolean;
  /**
   * Why a delegated task degraded to native (the host did it). Set ONLY on a
   * `status: 'native'` breadcrumb: `no_route` = routing found no selectable lane;
   * `host_native` = the chosen full lane was the host itself. Absent otherwise.
   */
  native_reason?: NativeReason;
}

/** What a caller provides for an outcome (review) event. */
export interface OutcomeEventInput {
  subject_id: string;
  subject_type: SubjectType;
  task_id?: string;
  turn_id?: string;
  review_id: string;
  attempt: number;
  category: TaskCategory;
  subject_lane_id?: string;
  subject_provenance?: string;
  /** Concrete model the subject lane ran (optional: host-turn + legacy events lack it). */
  subject_model?: string;
  /** Canonical model key after @latest/alias resolution (optional). */
  subject_model_resolved?: string;
  /** Escalation-depth difficulty bucket (optional). */
  difficulty?: DifficultyBucket;
  reviewer_lane_id: string;
  reviewer_model: string;
  reviewer_trust_mode: TrustMode;
  reviewer_provenance: string;
  verdict: ReviewVerdict;
  voter: Voter;
  policy_verdict: PolicyVerdict;
  /** C-13: the escalation action this review caused (content-free; optional). */
  action_taken?: OutcomeAction;
  /** C-13: lane id escalated TO, when `action_taken` is `escalate` (optional). */
  target_lane_id?: string;
}

export interface TaskEvent extends TaskEventInput, EventMeta {
  event_type: 'task';
}
export interface OutcomeEvent extends OutcomeEventInput, EventMeta {
  event_type: 'outcome';
}
export type LedgerEvent = TaskEvent | OutcomeEvent;

/** Allowlisted task-event fields (the content-free guarantee for task lines). */
export const EVENT_FIELDS = [
  'event_type', 'schema_version', 'id', 'seq', 'ts',
  'task_id', 'attempt', 'parent_task_id', 'category', 'laneId', 'model',
  'trust_mode', 'provenance', 'status',
  'tokens_in', 'tokens_out', 'tokens_estimated',
  'actual_cost', 'frontier_cost', 'metered_spent', 'frontier_avoided', 'metered_avoided',
  'policy_verdict', 'superseded', 'native_reason',
] as const satisfies readonly (keyof TaskEvent)[];

/** Allowlisted outcome-event fields. */
export const OUTCOME_EVENT_FIELDS = [
  'event_type', 'schema_version', 'id', 'seq', 'ts',
  'subject_id', 'subject_type', 'task_id', 'turn_id', 'review_id', 'attempt', 'category',
  'subject_lane_id', 'subject_provenance',
  'subject_model', 'subject_model_resolved', 'difficulty',
  'reviewer_lane_id', 'reviewer_model', 'reviewer_trust_mode', 'reviewer_provenance',
  'verdict', 'voter', 'policy_verdict', 'action_taken', 'target_lane_id',
] as const satisfies readonly (keyof OutcomeEvent)[];

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

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, where);
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
 * Validate a task-event input. Costs/spend must be >= 0; the avoided amounts are
 * **derived canonically** here so an inconsistent caller can never persist a
 * value that would skew savings (avoided may be negative when a lane costs more
 * than the frontier baseline).
 */
export function validateEventInput(input: TaskEventInput): TaskEventInput {
  const actual_cost = requireNonNegativeNumber(input.actual_cost, 'task.actual_cost');
  const frontier_cost = requireNonNegativeNumber(input.frontier_cost, 'task.frontier_cost');
  const metered_spent = requireNonNegativeNumber(input.metered_spent, 'task.metered_spent');
  const out: TaskEventInput = {
    task_id: requireString(input.task_id, 'task.task_id'),
    attempt: requireNonNegativeInt(input.attempt, 'task.attempt'),
    category: requireEnum(input.category, TASK_CATEGORIES, 'task.category'),
    laneId: requireString(input.laneId, 'task.laneId'),
    model: requireString(input.model, 'task.model'),
    trust_mode: requireEnum(input.trust_mode, TRUST_MODES, 'task.trust_mode'),
    provenance: requireString(input.provenance, 'task.provenance'),
    status: requireEnum(input.status, TASK_STATUSES, 'task.status'),
    tokens_in: requireNonNegativeInt(input.tokens_in, 'task.tokens_in'),
    tokens_out: requireNonNegativeInt(input.tokens_out, 'task.tokens_out'),
    tokens_estimated: requireBoolean(input.tokens_estimated, 'task.tokens_estimated'),
    actual_cost,
    frontier_cost,
    metered_spent,
    frontier_avoided: frontier_cost - actual_cost,
    metered_avoided: frontier_cost - metered_spent,
    policy_verdict: requireEnum(input.policy_verdict, POLICY_VERDICTS, 'task.policy_verdict'),
  };
  const parent = optionalString(input.parent_task_id, 'task.parent_task_id');
  if (parent !== undefined) out.parent_task_id = parent;
  if (input.superseded !== undefined) out.superseded = requireBoolean(input.superseded, 'task.superseded');
  if (input.native_reason !== undefined) {
    out.native_reason = requireEnum(input.native_reason, NATIVE_REASONS, 'task.native_reason');
  }
  return out;
}

/** Validate an outcome-event input. */
export function validateOutcomeInput(input: OutcomeEventInput): OutcomeEventInput {
  const out: OutcomeEventInput = {
    subject_id: requireString(input.subject_id, 'outcome.subject_id'),
    subject_type: requireEnum(input.subject_type, SUBJECT_TYPES, 'outcome.subject_type'),
    review_id: requireString(input.review_id, 'outcome.review_id'),
    attempt: requireNonNegativeInt(input.attempt, 'outcome.attempt'),
    category: requireEnum(input.category, TASK_CATEGORIES, 'outcome.category'),
    reviewer_lane_id: requireString(input.reviewer_lane_id, 'outcome.reviewer_lane_id'),
    reviewer_model: requireString(input.reviewer_model, 'outcome.reviewer_model'),
    reviewer_trust_mode: requireEnum(input.reviewer_trust_mode, TRUST_MODES, 'outcome.reviewer_trust_mode'),
    reviewer_provenance: requireString(input.reviewer_provenance, 'outcome.reviewer_provenance'),
    verdict: requireEnum(input.verdict, REVIEW_VERDICTS, 'outcome.verdict'),
    voter: requireEnum(input.voter, VOTERS, 'outcome.voter'),
    policy_verdict: requireEnum(input.policy_verdict, POLICY_VERDICTS, 'outcome.policy_verdict'),
  };
  const task_id = optionalString(input.task_id, 'outcome.task_id');
  if (task_id !== undefined) out.task_id = task_id;
  const turn_id = optionalString(input.turn_id, 'outcome.turn_id');
  if (turn_id !== undefined) out.turn_id = turn_id;
  const subject_lane_id = optionalString(input.subject_lane_id, 'outcome.subject_lane_id');
  if (subject_lane_id !== undefined) out.subject_lane_id = subject_lane_id;
  const subject_provenance = optionalString(input.subject_provenance, 'outcome.subject_provenance');
  if (subject_provenance !== undefined) out.subject_provenance = subject_provenance;
  const subject_model = optionalString(input.subject_model, 'outcome.subject_model');
  if (subject_model !== undefined) out.subject_model = subject_model;
  const subject_model_resolved = optionalString(input.subject_model_resolved, 'outcome.subject_model_resolved');
  if (subject_model_resolved !== undefined) out.subject_model_resolved = subject_model_resolved;
  if (input.difficulty !== undefined) {
    out.difficulty = requireEnum(input.difficulty, DIFFICULTY_BUCKETS, 'outcome.difficulty');
  }
  // C-13 escalation telemetry (optional, content-free).
  if (input.action_taken !== undefined) {
    out.action_taken = requireEnum(input.action_taken, OUTCOME_ACTIONS, 'outcome.action_taken');
  }
  const target_lane_id = optionalString(input.target_lane_id, 'outcome.target_lane_id');
  if (target_lane_id !== undefined) out.target_lane_id = target_lane_id;
  return out;
}

function serializeFields<T>(event: T, fields: readonly (keyof T)[]): string {
  const record: Record<string, unknown> = {};
  for (const field of fields) {
    const value = event[field];
    if (value !== undefined) record[field as string] = value; // omit absent optionals
  }
  return JSON.stringify(record);
}

/** Serialize an event to a single JSONL line containing ONLY its allowlisted fields. */
export function serializeEvent(event: LedgerEvent): string {
  return event.event_type === 'task'
    ? serializeFields(event, EVENT_FIELDS)
    : serializeFields(event, OUTCOME_EVENT_FIELDS);
}

function parseMeta(obj: Record<string, unknown>): EventMeta & { event_type: 'task' | 'outcome' } {
  // A row with no `event_type` is a legacy task line (pre-union schema).
  const event_type =
    obj.event_type === undefined
      ? 'task'
      : requireEnum(obj.event_type, ['task', 'outcome'] as const, 'event.event_type');
  const schema_version =
    obj.schema_version === undefined ? 0 : requireNonNegativeInt(obj.schema_version, 'event.schema_version');
  return {
    event_type,
    schema_version,
    id: requireString(obj.id, 'event.id'),
    seq: requireNonNegativeInt(obj.seq, 'event.seq'),
    ts: requireIsoTimestamp(obj.ts, 'event.ts'),
  };
}

/**
 * Backfill the fields the pre-union task schema lacked, so an existing ledger
 * keeps reading after an upgrade. Legacy task events were all completed, trusted
 * work, so the defaults reflect that.
 */
function backfillLegacyTask(obj: Record<string, unknown>): Record<string, unknown> {
  return {
    task_id: obj.id,
    attempt: 0,
    // A legacy `block` verdict was a blocked send — preserve it so blockCount holds.
    status: obj.policy_verdict === 'block' ? 'blocked' : 'ok',
    trust_mode: 'full',
    provenance: 'unknown',
    ...obj, // any field actually present on the row wins over the legacy default
  };
}

/** Parse and validate one ledger record into a {@link LedgerEvent}. */
export function parseEvent(obj: unknown): LedgerEvent {
  if (!isPlainObject(obj)) {
    throw new LedgerError('Ledger record must be a JSON object.');
  }
  const meta = parseMeta(obj);
  if (meta.event_type === 'task') {
    const source = obj.event_type === undefined ? backfillLegacyTask(obj) : obj;
    return { ...meta, event_type: 'task', ...validateEventInput(source as unknown as TaskEventInput) };
  }
  return { ...meta, event_type: 'outcome', ...validateOutcomeInput(obj as unknown as OutcomeEventInput) };
}

/**
 * Events at or after `sinceIso` (all if omitted). Timestamps are compared as
 * parsed instants, not lexicographically, so any valid ISO cutoff works.
 */
export function filterEventsSince<E extends { ts: string }>(events: readonly E[], sinceIso?: string): E[] {
  if (sinceIso === undefined) return [...events];
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) {
    throw new LedgerError(`filterEventsSince: invalid ISO timestamp ${JSON.stringify(sinceIso)}.`);
  }
  return events.filter((e) => Date.parse(e.ts) >= since);
}

function taskEventsOf(events: readonly LedgerEvent[]): TaskEvent[] {
  return events.filter((e): e is TaskEvent => e.event_type === 'task');
}

/** Per-period dollar + savings summary over the task events in a set. */
export interface LedgerSummary {
  events: number;
  /** Canonical savings (totals + frontier/metered percentages) over `ok` tasks only. */
  savings: SavingsSummary;
  /** Σ actual_cost over ALL task events (real spend, including failed/fallback). */
  actual_cost: number;
  /** Σ metered_spent over ALL task events (real metered spend). */
  metered_spent_total: number;
  /** Event count per lane id (real attempts only — excludes `native` breadcrumbs). */
  laneMix: Record<string, number>;
  /** Number of task events whose status is `blocked`. */
  blockCount: number;
  /**
   * Number of `native` breadcrumbs: delegated tasks that degraded to the host with
   * no lane running them. NOT counted in `events` (offloads), `laneMix`, or savings —
   * a separate visibility tally so a silent native degrade shows up.
   */
  nativeFallbacks: number;
}

/**
 * Summarize task events with an honest net: the frontier baseline counts only
 * **delivered (`status: 'ok'`) work**, while avoided amounts subtract **all**
 * real spend (including failed/fallback attempts). So a failed metered attempt
 * that cost money reduces the avoided figure rather than being ignored — the
 * headline never over-claims, and spend never under-reports. Outcome events are
 * ignored here.
 */
export function summarize(events: readonly LedgerEvent[]): LedgerSummary {
  const tasks = taskEventsOf(events);
  let frontier_cost = 0; // baseline over delivered (ok) work
  let actual_cost = 0; // real spend over ALL real attempts
  let metered_spent_total = 0; // real metered spend over ALL real attempts
  let blockCount = 0;
  let nativeFallbacks = 0;
  let realEvents = 0; // task events that actually attempted a lane (excludes native breadcrumbs)
  const laneMix: Record<string, number> = Object.create(null);
  for (const e of tasks) {
    // A `native` breadcrumb is not a real attempt: no lane ran it. It carries zero
    // spend/tokens and must not count as an offload, a block, lane mix, or savings —
    // only as a native-fallback tally for visibility.
    if (e.status === 'native') {
      nativeFallbacks += 1;
      continue;
    }
    realEvents += 1;
    actual_cost += e.actual_cost;
    metered_spent_total += e.metered_spent;
    if (e.status === 'blocked') blockCount += 1;
    // Savings baseline counts only DELIVERED ok work — a superseded (reworked-away
    // / rejected / given-back) leg consumed spend but delivered nothing, so it must
    // not claim frontier_avoided. Its actual/metered spend above still counts.
    if (e.status === 'ok' && e.superseded !== true) frontier_cost += e.frontier_cost;
    laneMix[e.laneId] = (laneMix[e.laneId] ?? 0) + 1;
  }
  const frontier_avoided = frontier_cost - actual_cost;
  const metered_avoided = frontier_cost - metered_spent_total;
  const pct = (n: number): number => (frontier_cost === 0 ? 0 : (100 * n) / frontier_cost);
  const savings: SavingsSummary = {
    frontier_cost,
    frontier_avoided,
    metered_spent: metered_spent_total,
    metered_avoided,
    frontier_avoided_pct: pct(frontier_avoided),
    metered_avoided_pct: pct(metered_avoided),
  };
  return { events: realEvents, savings, actual_cost, metered_spent_total, laneMix, blockCount, nativeFallbacks };
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
 * Pure token usage stats over the task events in a set: overall, per model, and
 * per lane (incl. $0 local lanes). Invariants hold by construction:
 * `estimated.total + reported.total === total`, and Σ byModel == Σ byLane == total.
 */
export function tokenStats(events: readonly LedgerEvent[]): TokenStats {
  const total = emptyBucket();
  const byModel: Record<string, TokenGroup> = Object.create(null);
  const byLane: Record<string, TokenGroup> = Object.create(null);
  for (const e of taskEventsOf(events)) {
    addToBucket(total, e);
    group(byModel, e.model, e);
    group(byLane, e.laneId, e);
  }
  return { total, byModel, byLane };
}

/** Verdict tallies for a group of outcome (review) events. */
export interface OutcomeGroup {
  pass: number;
  needs_rework: number;
  fail: number;
  total: number;
  /** (pass + ½·needs_rework) / total — the dogfood success scale; 0 when empty. */
  success_rate: number;
}

/** Per-offload escalation stats (C-13), measured per distinct router-task `task_id`. */
export interface EscalationStats {
  /** Distinct offloads that got at least one router-task review. */
  offloadsReviewed: number;
  /** Of those, how many escalated at least once. */
  escalated: number;
  /** escalated / offloadsReviewed — 0 when none reviewed. */
  rate: number;
}

/** Outcome stats overall and per reviewed lane, plus per-offload escalation. */
export interface OutcomeStats {
  total: OutcomeGroup;
  byLane: Record<string, OutcomeGroup>;
  escalation: EscalationStats;
}

/** Bucket keys when a review has no subject lane: host-turn vs an unattributed router task. */
const HOST_SUBJECT = '(host)';
const UNATTRIBUTED_SUBJECT = '(unattributed)';

function emptyOutcomeGroup(): OutcomeGroup {
  return { pass: 0, needs_rework: 0, fail: 0, total: 0, success_rate: 0 };
}

function tallyVerdict(g: OutcomeGroup, verdict: ReviewVerdict): void {
  if (verdict === 'pass') g.pass += 1;
  else if (verdict === 'needs-rework') g.needs_rework += 1;
  else g.fail += 1;
  g.total += 1;
  g.success_rate = g.total === 0 ? 0 : (g.pass + 0.5 * g.needs_rework) / g.total;
}

/**
 * Pure verdict aggregation over the outcome (review) events: overall and per
 * reviewed lane (`subject_lane_id`, or `(host)` for host-turn reviews). Task
 * events are ignored.
 */
export function outcomeStats(events: readonly LedgerEvent[]): OutcomeStats {
  const total = emptyOutcomeGroup();
  const byLane: Record<string, OutcomeGroup> = Object.create(null);
  // Per-offload escalation rate: distinct router-task offloads (by task_id) that
  // got any review vs. those that escalated at least once. Host-turn reviews never
  // dilute it.
  const reviewedOffloads = new Set<string>();
  const escalatedOffloads = new Set<string>();
  for (const e of events) {
    if (e.event_type !== 'outcome') continue;
    tallyVerdict(total, e.verdict);
    // Only host-turn reviews bucket under (host); a lane-less router task is
    // unattributed, never conflated with host work.
    const key = e.subject_lane_id ?? (e.subject_type === 'host_turn' ? HOST_SUBJECT : UNATTRIBUTED_SUBJECT);
    if (!byLane[key]) byLane[key] = emptyOutcomeGroup();
    tallyVerdict(byLane[key]!, e.verdict);
    if (e.subject_type === 'router_task' && e.task_id) {
      reviewedOffloads.add(e.task_id);
      if (e.action_taken === 'escalate') escalatedOffloads.add(e.task_id);
    }
  }
  const escalation: EscalationStats = {
    offloadsReviewed: reviewedOffloads.size,
    escalated: escalatedOffloads.size,
    rate: reviewedOffloads.size === 0 ? 0 : escalatedOffloads.size / reviewedOffloads.size,
  };
  return { total, byLane, escalation };
}
