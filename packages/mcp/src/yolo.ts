/**
 * YOLO — project-keyed "dangerously-permissive routing" toggle (adapter-level UX,
 * not core routing). The analogue of `--dangerously-skip-permissions`: when ON, the
 * router opens every trust/egress gate so EVERY configured worker/reader lane is
 * selectable, regardless of repo_class/sensitivity, the gate-ready / reader-egress
 * opt-ins, or per-lane attestations (see core `eligibleLanes`). It does NOT disable
 * the secret scanner or the user-owned-config / RCE guard — those still apply.
 *
 * OFF BY DEFAULT: a project with no stored entry routes with all gates closed; only
 * an explicit opt-in (the `/tokenmaxed:yolo` skill → `router_set_yolo`, or the
 * `TOKENMAXED_YOLO` env fallback) turns it on.
 *
 * PURE: the persistence store is injected ({@link YoloStore}), so the read/write
 * logic is unit-tested without I/O. The server backs the store with a JSON file in
 * ${CLAUDE_PLUGIN_DATA}, keyed by the project dir, so YOLO in one project never
 * affects another and survives restarts/updates. A stored per-project value always
 * overrides the env-var fallback.
 */

/** Injected persistence: read() returns the parsed JSON (any shape), write() saves the map. */
export interface YoloStore {
  read: () => unknown;
  write: (state: Record<string, boolean>) => void;
}

/** Coerce arbitrary parsed JSON into a clean {projectKey: yolo} boolean map. */
function asMap(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/**
 * Whether YOLO mode is on for `projectKey`. A stored per-project value wins; when
 * unset, `fallback` decides (default `false` ⇒ OFF). `fallback` lets the server
 * pass the `TOKENMAXED_YOLO` env default while an explicit `/tokenmaxed:yolo`
 * choice for the project still overrides it.
 */
export function readYolo(store: YoloStore, projectKey: string, fallback = false): boolean {
  const map = asMap(store.read());
  return Object.hasOwn(map, projectKey) ? map[projectKey]! : fallback;
}

/** Persist the YOLO state for `projectKey`, preserving other projects' entries. */
export function writeYolo(store: YoloStore, projectKey: string, on: boolean): void {
  const map = asMap(store.read());
  map[projectKey] = on;
  store.write(map);
}
