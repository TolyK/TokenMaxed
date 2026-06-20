/**
 * P6 Phase 2a — pure local leaderboard aggregator. Rolls reviewer-cast router-task
 * outcomes into per-(model, category, difficulty) rows with verdict counts,
 * dogfood pass rate, and token sums joined from task events. No I/O, no upload,
 * no clock — a view over the content-free ledger only.
 *
 * Caveat: measures who passes real reviews at difficulty D, not ground-truth
 * capability (reviewer strictness, selection bias, escalation-depth confound).
 */

import type { DifficultyBucket, LedgerEvent, OutcomeEvent, TaskEvent } from './ledger.ts';
import type { TaskCategory } from './types.ts';

/** NUL — separator that cannot collide with id/category content. */
const SEP = '\u0000';

export type LeaderboardDifficulty = DifficultyBucket | 'unknown';

/** One leaderboard row: a (model, category, difficulty) cell with counts and token sums. */
export interface LeaderboardRow {
  model: string;
  category: TaskCategory;
  difficulty: LeaderboardDifficulty;
  pass: number;
  needs_rework: number;
  fail: number;
  total: number;
  passRate: number;
  tokens_in: number;
  tokens_out: number;
  users: number;
}

const DIFFICULTY_ORDER: Record<LeaderboardDifficulty, number> = {
  easy: 0,
  moderate: 1,
  hard: 2,
  unknown: 3,
};

function modelKeyFromOutcome(e: OutcomeEvent): string | undefined {
  const resolved = e.subject_model_resolved?.trim();
  if (resolved) return resolved;
  const raw = e.subject_model?.trim();
  if (raw) return raw;
  return undefined;
}

function isLeaderboardOutcome(e: LedgerEvent): e is OutcomeEvent {
  return (
    e.event_type === 'outcome' &&
    e.subject_type === 'router_task' &&
    e.voter === 'reviewer_model'
  );
}

function taskKey(task_id: string, attempt: number): string {
  return [task_id, attempt].join(SEP);
}

function cellKey(model: string, category: TaskCategory, difficulty: LeaderboardDifficulty): string {
  return [model, category, difficulty].join(SEP);
}

interface CellAccumulator {
  model: string;
  category: TaskCategory;
  difficulty: LeaderboardDifficulty;
  pass: number;
  needs_rework: number;
  fail: number;
  tokens_in: number;
  tokens_out: number;
}

/**
 * Build leaderboard rows from ledger events. Groups reviewer-cast router-task
 * outcomes by (subject_model_resolved ?? subject_model, category, difficulty).
 * Skips outcomes without a model key. Token sums join task events on (task_id, attempt).
 */
export function buildLeaderboard(events: readonly LedgerEvent[]): LeaderboardRow[] {
  const taskIndex = new Map<string, TaskEvent>();
  for (const e of events) {
    if (e.event_type === 'task') {
      taskIndex.set(taskKey(e.task_id, e.attempt), e);
    }
  }

  const cells = new Map<string, CellAccumulator>();

  for (const e of events) {
    if (!isLeaderboardOutcome(e)) continue;
    const model = modelKeyFromOutcome(e);
    if (!model) continue;

    const difficulty: LeaderboardDifficulty = e.difficulty ?? 'unknown';
    const key = cellKey(model, e.category, difficulty);

    let cell = cells.get(key);
    if (!cell) {
      cell = { model, category: e.category, difficulty, pass: 0, needs_rework: 0, fail: 0, tokens_in: 0, tokens_out: 0 };
      cells.set(key, cell);
    }

    if (e.verdict === 'pass') cell.pass += 1;
    else if (e.verdict === 'needs-rework') cell.needs_rework += 1;
    else cell.fail += 1;

    if (typeof e.task_id === 'string' && e.task_id !== '') {
      const task = taskIndex.get(taskKey(e.task_id, e.attempt));
      if (task) {
        cell.tokens_in += task.tokens_in;
        cell.tokens_out += task.tokens_out;
      }
    }
  }

  const rows: LeaderboardRow[] = [];
  for (const cell of cells.values()) {
    const total = cell.pass + cell.needs_rework + cell.fail;
    rows.push({
      model: cell.model,
      category: cell.category,
      difficulty: cell.difficulty,
      pass: cell.pass,
      needs_rework: cell.needs_rework,
      fail: cell.fail,
      total,
      passRate: total === 0 ? 0 : (cell.pass + 0.5 * cell.needs_rework) / total,
      tokens_in: cell.tokens_in,
      tokens_out: cell.tokens_out,
      users: 1, // Phase 2b: distinct contributor count
    });
  }
  return rows;
}

export type LeaderboardSortBy = 'performance' | 'tokens' | 'difficulty';

function compareCellKeys(a: LeaderboardRow, b: LeaderboardRow): number {
  const ka = cellKey(a.model, a.category, a.difficulty);
  const kb = cellKey(b.model, b.category, b.difficulty);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function comparePerformance(a: LeaderboardRow, b: LeaderboardRow): number {
  if (b.passRate !== a.passRate) return b.passRate - a.passRate;
  if (b.total !== a.total) return b.total - a.total;
  return compareCellKeys(a, b);
}

/** Return a newly sorted copy of leaderboard rows (input is never mutated). */
export function sortLeaderboard(rows: readonly LeaderboardRow[], by: LeaderboardSortBy): LeaderboardRow[] {
  const sorted = [...rows];
  if (by === 'performance') {
    sorted.sort(comparePerformance);
  } else if (by === 'tokens') {
    // §6.5: cheapest-capable first — ascending total tokens, then higher passRate.
    sorted.sort((a, b) => {
      const ta = a.tokens_in + a.tokens_out;
      const tb = b.tokens_in + b.tokens_out;
      if (ta !== tb) return ta - tb;
      if (b.passRate !== a.passRate) return b.passRate - a.passRate;
      return compareCellKeys(a, b);
    });
  } else {
    sorted.sort((a, b) => {
      const da = DIFFICULTY_ORDER[a.difficulty];
      const db = DIFFICULTY_ORDER[b.difficulty];
      if (da !== db) return da - db;
      return comparePerformance(a, b);
    });
  }
  return sorted;
}