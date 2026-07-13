/**
 * Project-keyed learning-frozen toggle (adapter-level UX, not core routing).
 *
 * PURE: the persistence store is injected ({@link FreezeStore}), so the read/write
 * logic is unit-tested without I/O. The server backs the store with a JSON file in
 * ${CLAUDE_PLUGIN_DATA}, keyed by the project dir.
 *
 * Default is NOT FROZEN: a project with no stored entry is not frozen; only an
 * explicit `/tokenmaxed:freeze on` records `true`.
 */

export interface FreezeStore {
  read: () => unknown;
  write: (state: Record<string, boolean>) => void;
}

const FROZEN_BY_DEFAULT = false;

/** Coerce arbitrary parsed JSON into a clean {projectKey: frozen} boolean map. */
function asMap(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Whether learning is frozen for `projectKey` (default false when unset). */
export function readFrozen(store: FreezeStore, projectKey: string): boolean {
  const map = asMap(store.read());
  return Object.hasOwn(map, projectKey) ? map[projectKey]! : FROZEN_BY_DEFAULT;
}

/** Persist the frozen state for `projectKey`, preserving other projects' entries. */
export function writeFrozen(store: FreezeStore, projectKey: string, frozen: boolean): void {
  const map = asMap(store.read());
  map[projectKey] = frozen;
  store.write(map);
}
