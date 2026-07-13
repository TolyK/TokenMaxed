/**
 * Per-project manual quota calibration persistence (adapter-level UX).
 *
 * PURE functions over an injected store ({@link CalibrationStore}), like reserve.ts —
 * read/write logic is unit-tested without I/O. The server backs it with a JSON file
 * keyed by the project dir, so a calibration in one project never affects another and
 * survives restarts/updates.
 *
 * Stores a map of laneId/model -> fraction (number in 0..1) per project.
 */

export interface CalibrationStore {
  read: () => unknown;
  write: (state: Record<string, Record<string, number>>) => void;
}

function asMap(raw: unknown): Record<string, Record<string, number>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, number>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const subMap: Record<string, number> = {};
      for (const [subK, subV] of Object.entries(v as Record<string, unknown>)) {
        if (typeof subV === 'number' && Number.isFinite(subV) && subV >= 0 && subV <= 1) {
          subMap[subK] = subV;
        }
      }
      if (Object.keys(subMap).length > 0) {
        out[k] = subMap;
      }
    }
  }
  return out;
}

export function readCalibrations(store: CalibrationStore, projectKey: string): Record<string, number> {
  const map = asMap(store.read());
  return Object.hasOwn(map, projectKey) ? map[projectKey]! : {};
}

export function writeCalibration(
  store: CalibrationStore,
  projectKey: string,
  key: string | undefined,
  fraction: number | undefined,
): void {
  const map = asMap(store.read());
  if (key === undefined) {
    delete map[projectKey];
  } else {
    const subMap = map[projectKey] ?? {};
    if (fraction !== undefined && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1) {
      subMap[key] = fraction;
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
