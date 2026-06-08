/**
 * Per-project "preferred lane" persistence (adapter-level UX, not core routing).
 *
 * PURE functions over an injected store ({@link PreferStore}), like toggle.ts —
 * read/write logic is unit-tested without I/O. The server backs it with a JSON file
 * keyed by the project dir, so a preference in one project never affects another and
 * survives restarts/updates.
 *
 * Stores a single lane id string per project; the routing core reads it via
 * `RouteContext.preferLaneId`:
 * - Absent / empty entry ⇒ NO preference (normal capability-ranked routing).
 * - Present entry        ⇒ the router favors that lane when it is eligible, available,
 *                          and capable for the task; otherwise it falls back normally.
 *
 * Intended to make it easy to flip "for now, route work to lane X" on/off without a
 * relaunch or rewriting routing config — for ANY configured lane id (any vendor, CLI
 * or API), e.g. to conserve one subscription's credits during a sprint.
 */

/** Injected persistence: read() returns the parsed JSON (any shape), write() saves the map. */
export interface PreferStore {
  read: () => unknown;
  write: (state: Record<string, string>) => void;
}

/** Coerce arbitrary parsed JSON into a clean {projectKey: laneId} string map. */
function asMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

/** The preferred lane id for `projectKey`, or undefined when unset/empty. */
export function readPreferred(store: PreferStore, projectKey: string): string | undefined {
  const map = asMap(store.read());
  return Object.hasOwn(map, projectKey) ? map[projectKey]! : undefined;
}

/**
 * Set (non-empty `laneId`) or clear (undefined/empty ⇒ delete the entry) the preferred
 * lane for `projectKey`, preserving other projects' entries.
 */
export function writePreferred(store: PreferStore, projectKey: string, laneId: string | undefined): void {
  const map = asMap(store.read());
  if (typeof laneId === 'string' && laneId.length > 0) {
    map[projectKey] = laneId;
  } else {
    delete map[projectKey];
  }
  store.write(map);
}
