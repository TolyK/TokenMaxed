/**
 * D (P6 Phase 2b) — the cross-user leaderboard share machinery, LOCAL-ONLY for
 * now: the content-free snapshot boundary, the replace-by-snapshot merge, and
 * the k-anonymity publisher. No upload code lives here — when the hosted
 * endpoint ships (Vercel, later), it transmits EXACTLY `serializeShareSnapshot`
 * output and runs EXACTLY `mergeShareSnapshots` + `publishLeaderboard`; the
 * boundary is designed and tested before any wire exists.
 *
 * PRIVACY (P6 §6, law):
 *  - A snapshot carries ONLY aggregate counts/sums keyed by
 *    (model, category, difficulty) — enums/ids/integers. Never per-task rows,
 *    never text, never timestamps finer than the window id. The allowlist
 *    serializer is the guarantee: anything not listed cannot serialize.
 *  - `contributor_id` is an opaque, rotatable pseudonym used ONLY for merge
 *    dedup; it is never published.
 *  - Re-upload is IDEMPOTENT by construction: a snapshot REPLACES the same
 *    contributor's prior snapshot for that window (revision-ordered), never
 *    adds — plain additive re-merge would double-count.
 *  - A published cell is SUPPRESSED until it has ≥ MIN_USERS distinct
 *    contributors AND ≥ MIN_TOTAL verdicts (operator decision: MIN_USERS = 5).
 *    The N=1 LOCAL view never leaves the machine and is never suppressed —
 *    suppression is a property of PUBLICATION, not of your own data.
 */

import type { LeaderboardRow } from './leaderboard.ts';
import type { LeaderboardDifficulty } from './leaderboard.ts';
import { TASK_CATEGORIES } from './types.ts';
import type { TaskCategory } from './types.ts';

/** Operator decision (2026-07-11): k-anonymity floor for any PUBLISHED cell. */
export const MIN_USERS = 5;
/** Minimum total verdicts for a published cell (thin cells stay private). */
export const MIN_TOTAL = 10;

/** One aggregate cell — the ONLY row shape that may ever cross the wire. */
export interface ShareRow {
  model: string;
  category: TaskCategory;
  difficulty: LeaderboardDifficulty;
  pass: number;
  needs_rework: number;
  fail: number;
  tokens_in: number;
  tokens_out: number;
}

/** A contributor's aggregated snapshot for one window. */
export interface ShareSnapshot {
  /** Opaque rotatable pseudonym — dedup only, NEVER published. */
  contributor_id: string;
  /** Coarse window identity (e.g. "2026-W28"); the finest time unit shared. */
  window_id: string;
  /** Monotonic per-(contributor, window) revision; the highest replaces. */
  revision: number;
  rows: ShareRow[];
}

/** The exhaustive allowlists — the content-free boundary (mirrors ledger.ts). */
export const SHARE_ROW_FIELDS = ['model', 'category', 'difficulty', 'pass', 'needs_rework', 'fail', 'tokens_in', 'tokens_out'] as const;
export const SHARE_SNAPSHOT_FIELDS = ['contributor_id', 'window_id', 'revision', 'rows'] as const;

/** Build a snapshot from local leaderboard rows (drops the derived fields). */
export function shareSnapshotFromRows(
  rows: readonly LeaderboardRow[],
  meta: { contributor_id: string; window_id: string; revision: number },
): ShareSnapshot {
  return {
    contributor_id: meta.contributor_id,
    window_id: meta.window_id,
    revision: meta.revision,
    rows: rows.map((r) => ({
      model: r.model,
      category: r.category,
      difficulty: r.difficulty,
      pass: r.pass,
      needs_rework: r.needs_rework,
      fail: r.fail,
      tokens_in: r.tokens_in,
      tokens_out: r.tokens_out,
    })),
  };
}

const SEP = ' ';
const cellKey = (r: { model: string; category: string; difficulty: string }): string =>
  [r.model, r.category, r.difficulty].join(SEP);

// --- runtime validation: the boundary enforces VALUES, not just field names ------

/**
 * STRUCTURAL provenance, not just format: a contributor id must be a UUIDv4
 * (generated at opt-in, never user-chosen — pseudorandom hex cannot carry
 * chosen text), and a window id must be an ISO week. The literal 'local'
 * sentinel is allowed for the on-machine N=1 view ONLY — the wire serializer
 * rejects it separately.
 */
const CONTRIBUTOR_RE = /^(local|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const WINDOW_RE = /^(local|\d{4}-W\d{2})$/;
/**
 * Model ids: bounded charset (structurally excludes free text/HTML), and — the
 * real guarantee — MEMBERSHIP in a trusted catalog when one is supplied
 * (`opts.knownModels`, e.g. the price-table model set; the server-side merge
 * always supplies one). The charset alone is defense-in-depth, not the boundary.
 */
const MODEL_RE = /^[A-Za-z0-9._@/:-]{1,128}$/;
const DIFFICULTIES: readonly LeaderboardDifficulty[] = ['easy', 'moderate', 'hard', 'unknown'];
/** Defensive bound: models × categories × difficulties can never legitimately near this. */
const MAX_ROWS = 10_000;

export type ValidateShareResult = { valid: true; snapshot: ShareSnapshot } | { valid: false; reason: string };

export interface ShareValidationOptions {
  /** Trusted model catalog; when supplied, every row.model must be a member. */
  knownModels?: ReadonlySet<string>;
}

/**
 * Merge posture — callers must CHOOSE: a trusted catalog (the only sanctioned
 * cross-user/server posture) or the explicit on-machine escape hatch. There is
 * no silent default that skips the catalog.
 */
export type MergeOptions = { knownModels: ReadonlySet<string> } | { localOnly: true };

function nonNegInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Validate + canonicalize a snapshot: strict id/model formats, real enum
 * membership, non-negative safe integers, unique cell keys, bounded row count,
 * rows re-built as fresh primitive-only objects in canonical (sorted) order —
 * so serialization is content-free by VALUE, not merely by field name, and
 * equal content always serializes identically (the merge tie-break relies on
 * this). Never throws.
 */
export function validateShareSnapshot(rawInput: unknown, opts: ShareValidationOptions = {}): ValidateShareResult {
  // Hostile runtime shapes (null, primitives, throwing getters) must yield
  // { valid: false }, never an exception — a server merge over mixed uploads
  // cannot be abortable by one bad payload.
  try {
    return validateInner(rawInput, opts);
  } catch (err) {
    return { valid: false, reason: `snapshot inspection threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateInner(rawInput: unknown, opts: ShareValidationOptions): ValidateShareResult {
  if (!isPlainObject(rawInput)) return { valid: false, reason: 'snapshot must be a plain object' };
  const input = rawInput as unknown as ShareSnapshot;
  // SINGLE-READ discipline (TOCTOU): every field is read EXACTLY ONCE into a
  // local; validation and the rebuilt output both use only the locals — a
  // getter that returns a clean value when checked and secret text when copied
  // has no second read to exploit.
  const contributor_id = input.contributor_id;
  const window_id = input.window_id;
  const revision = input.revision;
  const rawRows = input.rows;
  if (typeof contributor_id !== 'string' || !CONTRIBUTOR_RE.test(contributor_id)) {
    return { valid: false, reason: 'contributor_id must be a UUIDv4 (or the local sentinel)' };
  }
  if (typeof window_id !== 'string' || !WINDOW_RE.test(window_id)) {
    return { valid: false, reason: 'window_id must be an ISO week like 2026-W28 (or the local sentinel)' };
  }
  if (!nonNegInt(revision) || revision < 1) return { valid: false, reason: 'revision must be a positive safe integer' };
  if (!Array.isArray(rawRows)) return { valid: false, reason: 'rows must be an array' };
  if (rawRows.length > MAX_ROWS) return { valid: false, reason: `rows exceeds the ${MAX_ROWS} bound` };

  const seen = new Set<string>();
  const rows: ShareRow[] = [];
  for (const r of rawRows) {
    if (!isPlainObject(r)) return { valid: false, reason: 'row must be a plain object' };
    const model = (r as ShareRow).model;
    const category = (r as ShareRow).category;
    const difficulty = (r as ShareRow).difficulty;
    const pass = (r as ShareRow).pass;
    const needs_rework = (r as ShareRow).needs_rework;
    const fail = (r as ShareRow).fail;
    const tokens_in = (r as ShareRow).tokens_in;
    const tokens_out = (r as ShareRow).tokens_out;
    if (typeof model !== 'string' || !MODEL_RE.test(model)) return { valid: false, reason: 'row.model must be a bounded model id' };
    if (opts.knownModels && !opts.knownModels.has(model)) return { valid: false, reason: `row.model "${model}" is not in the trusted model catalog` };
    if (!(TASK_CATEGORIES as readonly string[]).includes(category)) return { valid: false, reason: 'row.category must be a known category' };
    if (!DIFFICULTIES.includes(difficulty)) return { valid: false, reason: 'row.difficulty must be easy|moderate|hard|unknown' };
    for (const [name, v] of [['pass', pass], ['needs_rework', needs_rework], ['fail', fail], ['tokens_in', tokens_in], ['tokens_out', tokens_out]] as const) {
      if (!nonNegInt(v)) return { valid: false, reason: `row.${name} must be a non-negative safe integer` };
    }
    const key = cellKey({ model, category, difficulty });
    if (seen.has(key)) return { valid: false, reason: `duplicate cell ${key}` };
    seen.add(key);
    // Built ONLY from the single-read locals — never a second property access.
    rows.push({ model, category, difficulty, pass, needs_rework, fail, tokens_in, tokens_out });
  }
  rows.sort((a, b) => cellKey(a).localeCompare(cellKey(b))); // canonical order
  return { valid: true, snapshot: { contributor_id, window_id, revision, rows } };
}

/**
 * Serialize through the allowlist AND the value validator: ONLY the listed
 * fields with VALIDATED primitive values can ever reach the wire. Throws on an
 * invalid snapshot — the wire fails closed, never "mostly clean".
 */
export function serializeShareSnapshot(snapshot: ShareSnapshot, opts: { knownModels: ReadonlySet<string> }): string {
  // The catalog is MANDATORY at the wire — no caller can forget it.
  const validated = validateShareSnapshot(snapshot, opts);
  if (!validated.valid) throw new Error(`refusing to serialize invalid share snapshot: ${validated.reason}`);
  const s = validated.snapshot;
  // The 'local' sentinel is for the on-machine view only — it must never wire.
  if (s.contributor_id === 'local' || s.window_id === 'local') {
    throw new Error('refusing to serialize the local sentinel — wire snapshots need a generated contributor UUID and an ISO week');
  }
  const rows = s.rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const f of SHARE_ROW_FIELDS) out[f] = r[f];
    return out;
  });
  const top: Record<string, unknown> = {};
  for (const f of SHARE_SNAPSHOT_FIELDS) top[f] = f === 'rows' ? rows : s[f];
  return JSON.stringify(top);
}

/** A merged cell across distinct contributors. */
export interface MergedCell extends Omit<ShareRow, never> {
  /** DISTINCT contributors whose snapshots fed this cell. */
  users: number;
}

/**
 * Merge snapshots: VALIDATE each (invalid snapshots are ignored — a hostile
 * upload can never poison the aggregate), then keep the winning snapshot per
 * (contributor, window): the highest revision REPLACES, never adds; an
 * equal-revision conflict resolves by the lexicographically-greater CANONICAL
 * serialization (validation sorts rows, so equal content serializes equal) —
 * fully deterministic and input-order independent. Then sum cells across
 * DISTINCT contributors.
 */
export function mergeShareSnapshots(snapshots: readonly unknown[], opts: MergeOptions): MergedCell[] {
  const validationOpts: ShareValidationOptions = 'knownModels' in opts ? { knownModels: opts.knownModels } : {};
  const latest = new Map<string, { snapshot: ShareSnapshot; canonical: string }>();
  for (const raw of snapshots) {
    const validated = validateShareSnapshot(raw, validationOpts);
    if (!validated.valid) continue; // fail closed per snapshot
    const s = validated.snapshot;
    const canonical = JSON.stringify(s); // canonical: validated + sorted rows
    const key = [s.contributor_id, s.window_id].join(SEP);
    const prev = latest.get(key);
    if (!prev || s.revision > prev.snapshot.revision || (s.revision === prev.snapshot.revision && canonical > prev.canonical)) {
      latest.set(key, { snapshot: s, canonical });
    }
  }

  const cells = new Map<string, MergedCell & { contributors: Set<string> }>();
  for (const { snapshot: s } of latest.values()) {
    for (const r of s.rows) {
      const key = cellKey(r);
      let cell = cells.get(key);
      if (!cell) {
        cell = { model: r.model, category: r.category, difficulty: r.difficulty, pass: 0, needs_rework: 0, fail: 0, tokens_in: 0, tokens_out: 0, users: 0, contributors: new Set() };
        cells.set(key, cell);
      }
      cell.pass += r.pass;
      cell.needs_rework += r.needs_rework;
      cell.fail += r.fail;
      cell.tokens_in += r.tokens_in;
      cell.tokens_out += r.tokens_out;
      cell.contributors.add(s.contributor_id);
    }
  }

  return [...cells.values()]
    .map(({ contributors, ...cell }) => ({ ...cell, users: contributors.size }))
    .sort((a, b) => cellKey(a).localeCompare(cellKey(b)));
}

export interface PublishOptions {
  minUsers?: number;
  minTotal?: number;
}

/**
 * The PUBLISHED view: cells suppressed until ≥ minUsers distinct contributors
 * AND ≥ minTotal verdicts. Applies ONLY to cross-user publication — a local
 * N=1 chart renders unsuppressed because it never leaves the machine.
 */
export function publishLeaderboard(cells: readonly MergedCell[], opts: PublishOptions = {}): MergedCell[] {
  const minUsers = opts.minUsers ?? MIN_USERS;
  const minTotal = opts.minTotal ?? MIN_TOTAL;
  return cells.filter((c) => c.users >= minUsers && c.pass + c.needs_rework + c.fail >= minTotal);
}
