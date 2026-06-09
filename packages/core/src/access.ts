/**
 * Access-need classification + the worker give-back signal (tandem routing).
 * Pure: no I/O, no imports. Two orthogonal axes live here —
 *  - `inferAccessNeed` resolves the caller's `access_need` (possibly `auto`) to a
 *    concrete value the router gates on, deciding whether a blind worker may be
 *    tried at all; and
 *  - `parseGiveBackSignal` reads a worker's reply for the sentinel it emits when
 *    it cannot finish without repository/file/tool access it was never given.
 * Together they let a worker handle as much as possible while a full-access lane
 * steps in for genuinely repo-tight work.
 */

import type { AccessNeed, AccessNeedInput } from './types.ts';

/**
 * The exact sentinel a blind worker emits at the very START of its reply when it
 * genuinely cannot complete the task without repository/file/tool access it was
 * not given. Shared so the worker framing and the parser cannot drift.
 */
export const INSUFFICIENT_CONTEXT_SENTINEL = 'INSUFFICIENT_CONTEXT:';

/** Result of parsing a worker reply for the give-back signal. */
export interface GiveBackSignal {
  /** true ⇒ the worker declared it lacks required context and handed the task back. */
  insufficient: boolean;
  /** When insufficient, the worker's one-line description of what it needs (may be ''). */
  needed?: string;
}

/**
 * Max length of the extracted give-back need. The framing asks for a single short
 * line; we additionally bound it so a misbehaving worker can't bubble an arbitrarily
 * long string up to the host as the hand-off reason.
 */
const MAX_NEEDED_CHARS = 200;

/**
 * Resolve a caller-supplied {@link AccessNeedInput} (possibly `auto` or absent) to
 * a concrete {@link AccessNeed} the router can gate on. An explicit `worker-ok` or
 * `repo-tight` is always honored. Everything else — `auto`, `undefined`, or any
 * unexpected value — resolves to `worker-ok`: a deliberate product decision (every
 * untagged subtask tries a worker, and the {@link parseGiveBackSignal} give-back is
 * the safety net for the rare repo-tight miss). `instruction`/`files` are accepted
 * only so a future heuristic can slot in here without a signature change; they are
 * intentionally unread today.
 */
export function inferAccessNeed(
  input: AccessNeedInput | undefined,
  instruction: string,
  files?: readonly string[],
): AccessNeed {
  void instruction;
  void files;
  if (input === 'worker-ok' || input === 'repo-tight') return input;
  return 'worker-ok';
}

/**
 * Parse a worker reply for the give-back sentinel. If the trimmed text begins with
 * {@link INSUFFICIENT_CONTEXT_SENTINEL} (matched case-insensitively), returns
 * `{ insufficient: true, needed }` where `needed` is the FIRST line after the
 * sentinel — trimmed, original casing preserved, and capped at
 * {@link MAX_NEEDED_CHARS} (the framing asks for a single short line; this bounds a
 * misbehaving worker, possibly `''`). Otherwise — empty text or no sentinel prefix —
 * returns `{ insufficient: false }`.
 */
export function parseGiveBackSignal(text: string): GiveBackSignal {
  const trimmed = text.trim();
  const sentinel = INSUFFICIENT_CONTEXT_SENTINEL;
  if (trimmed.length >= sentinel.length && trimmed.slice(0, sentinel.length).toUpperCase() === sentinel) {
    // Single short line only: take the first line of the remainder, then bound it.
    const firstLine = trimmed.slice(sentinel.length).split('\n', 1)[0]!.trim();
    return { insufficient: true, needed: firstLine.slice(0, MAX_NEEDED_CHARS) };
  }
  return { insufficient: false };
}
