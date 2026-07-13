/**
 * Per-project target datetime overrides persistence (adapter-level UX).
 *
 * PURE functions over an injected store ({@link TargetStore}), like reserve.ts —
 * read/write logic is unit-tested without I/O. The server backs it with a JSON file
 * keyed by the project dir, so a target in one project never affects another and
 * survives restarts/updates.
 *
 * Stores a map of laneId/model -> ISO-8601 datetime string per project.
 */

export interface TargetStore {
  read: () => unknown;
  write: (state: Record<string, Record<string, string>>) => void;
}

export function isValidIso8601(val: string): boolean {
  const trimmed = val.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.exec(trimmed);
  if (!match) return false;

  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  const day = parseInt(match[3]!, 10);
  const hour = parseInt(match[4]!, 10);
  const minute = parseInt(match[5]!, 10);
  const second = match[6] ? parseInt(match[6], 10) : 0;
  const ms = match[7] ? parseInt(match[7].padEnd(3, '0').slice(0, 3), 10) : 0;

  const utcD = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  if (
    utcD.getUTCFullYear() !== year ||
    utcD.getUTCMonth() !== month - 1 ||
    utcD.getUTCDate() !== day ||
    utcD.getUTCHours() !== hour ||
    utcD.getUTCMinutes() !== minute ||
    utcD.getUTCSeconds() !== second
  ) {
    return false;
  }

  const msParsed = Date.parse(trimmed);
  return Number.isFinite(msParsed);
}

function asMap(raw: unknown): Record<string, Record<string, string>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, string>> = {};
  const now = Date.now();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const subMap: Record<string, string> = {};
      for (const [subK, subV] of Object.entries(v as Record<string, unknown>)) {
        if (typeof subV === 'string' && isValidIso8601(subV)) {
          const ms = Date.parse(subV);
          if (ms > now) {
            subMap[subK] = subV.trim();
          }
        }
      }
      if (Object.keys(subMap).length > 0) {
        out[k] = subMap;
      }
    }
  }
  return out;
}

export function readTargets(store: TargetStore, projectKey: string): Record<string, string> {
  const map = asMap(store.read());
  return Object.hasOwn(map, projectKey) ? map[projectKey]! : {};
}

export function writeTarget(
  store: TargetStore,
  projectKey: string,
  key: string | undefined,
  until: string | undefined,
): void {
  const map = asMap(store.read());
  if (key === undefined) {
    delete map[projectKey];
  } else {
    const subMap = map[projectKey] ?? {};
    if (until !== undefined) {
      const trimmed = until.trim();
      if (isValidIso8601(trimmed)) {
        const ms = Date.parse(trimmed);
        if (ms > Date.now()) {
          subMap[key] = trimmed;
        } else {
          delete subMap[key];
        }
      } else {
        delete subMap[key];
      }
    } else {
      delete subMap[key];
    }
    if (Object.keys(subMap).length > 0) {
      map[projectKey] = subMap;
    } else {
      delete map[projectKey];
    }
  }
  store.write(map);
}
