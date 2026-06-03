/**
 * A-4 — project-keyed enable/disable toggle (adapter-level UX, not core routing).
 *
 * PURE: the persistence store is injected ({@link ToggleStore}), so the read/write
 * logic is unit-tested without I/O. The server backs the store with a JSON file in
 * ${CLAUDE_PLUGIN_DATA}, keyed by the project dir, so disabling routing in one
 * project never affects another and survives restarts/updates.
 *
 * Default is ENABLED: a project with no stored entry routes normally; only an
 * explicit `/tokenmaxed:off` records `false`.
 */

/** Injected persistence: read() returns the parsed JSON (any shape), write() saves the map. */
export interface ToggleStore {
  read: () => unknown;
  write: (state: Record<string, boolean>) => void;
}

const ENABLED_BY_DEFAULT = true;

/** Coerce arbitrary parsed JSON into a clean {projectKey: enabled} boolean map. */
function asMap(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Whether routing is enabled for `projectKey` (default true when unset). */
export function readEnabled(store: ToggleStore, projectKey: string): boolean {
  const map = asMap(store.read());
  return Object.hasOwn(map, projectKey) ? map[projectKey]! : ENABLED_BY_DEFAULT;
}

/** Persist the enabled state for `projectKey`, preserving other projects' entries. */
export function writeEnabled(store: ToggleStore, projectKey: string, enabled: boolean): void {
  const map = asMap(store.read());
  map[projectKey] = enabled;
  store.write(map);
}
