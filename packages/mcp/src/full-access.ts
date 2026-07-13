/**
 * Per-project "Reader -> Full-Access Grant" persistence (adapter-level UX).
 *
 * PURE functions over an injected store ({@link FullAccessStore}), like prefer.ts —
 * read/write logic is unit-tested without I/O. The server backs it with a JSON file
 * keyed by the project dir, so a grant in one project never affects another and
 * survives restarts/updates.
 *
 * Stores a list of lane IDs per project. When granted, that reader lane's
 * ID is elevated to full repo access.
 */

/** Injected persistence: read() returns the parsed JSON (any shape), write() saves the map. */
export interface FullAccessStore {
  read: () => unknown;
  write: (state: Record<string, string[]>) => void;
}

/** Coerce arbitrary parsed JSON into a clean {projectKey: string[]} map. */
function asMap(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      const arr: string[] = [];
      for (const item of v) {
        if (typeof item === 'string') {
          const trimmed = item.trim();
          if (trimmed.length > 0) {
            arr.push(trimmed);
          }
        }
      }
      if (arr.length > 0) {
        out[k] = arr;
      }
    }
  }
  return out;
}

/** The granted lane IDs (fresh array) for `projectKey`, [] when unset; never duplicates. */
export function readFullAccess(store: FullAccessStore, projectKey: string): string[] {
  const map = asMap(store.read());
  const list = map[projectKey];
  if (!list) return [];
  // Return a fresh array and remove any case-insensitive duplicates (preserving first casing)
  const seen = new Set<string>();
  const out: string[] = [];
  for (const laneId of list) {
    const key = laneId.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(laneId);
    }
  }
  return out;
}

/**
 * Add trimmed `laneId`, preserving other projects/entries; no-op if empty/whitespace or already present case-insensitively (keep first casing).
 */
export function grantFullAccess(store: FullAccessStore, projectKey: string, laneId: string): void {
  if (typeof laneId !== 'string') return;
  const trimmed = laneId.trim();
  if (trimmed.length === 0) return;

  const map = asMap(store.read());
  const list = map[projectKey] ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  
  for (const l of list) {
    const key = l.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(l);
    }
  }

  const laneIdKey = trimmed.toLowerCase();
  if (!seen.has(laneIdKey)) {
    out.push(trimmed);
  }

  if (out.length > 0) {
    map[projectKey] = out;
  } else {
    delete map[projectKey];
  }
  store.write(map);
}

/**
 * Remove `laneId` case-insensitively; when omitted/empty, delete the whole project entry;
 * if the last lane ID is removed, delete the entry (no empty arrays left).
 */
export function revokeFullAccess(store: FullAccessStore, projectKey: string, laneId?: string): void {
  const map = asMap(store.read());
  if (!laneId || typeof laneId !== 'string' || laneId.trim().length === 0) {
    delete map[projectKey];
  } else {
    const trimmed = laneId.trim().toLowerCase();
    const list = map[projectKey];
    if (list) {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const l of list) {
        if (l.toLowerCase() !== trimmed) {
          const key = l.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            out.push(l);
          }
        }
      }
      if (out.length > 0) {
        map[projectKey] = out;
      } else {
        delete map[projectKey];
      }
    }
  }
  store.write(map);
}
