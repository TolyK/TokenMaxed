/**
 * Per-project "named routing policy" persistence (adapter-level UX, not core routing).
 *
 * PURE functions over an injected store ({@link PolicyStore}), like prefer.ts —
 * read/write logic is unit-tested without I/O. The server backs it with a JSON file
 * keyed by the project dir, so a policy in one project never affects another and
 * survives restarts/updates.
 *
 * Stores a single policy string per project; the routing core reads it via
 * `RouteContext.routingPolicy`:
 * - Absent / empty entry ⇒ NO policy (defaults to 'balanced').
 * - Present entry        ⇒ the router uses that named policy.
 */

export type NamedRoutingPolicy = 'balanced' | 'cheapest' | 'preserve-frontier' | 'reliable';

export const NAMED_ROUTING_POLICIES: readonly NamedRoutingPolicy[] = [
  'balanced',
  'cheapest',
  'preserve-frontier',
  'reliable',
] as const;

export function isValidRoutingPolicy(val: unknown): val is NamedRoutingPolicy {
  return typeof val === 'string' && (NAMED_ROUTING_POLICIES as readonly string[]).includes(val);
}

export interface PolicyStore {
  read: () => unknown;
  write: (state: Record<string, NamedRoutingPolicy>) => void;
}

/** Coerce arbitrary parsed JSON into a clean {projectKey: policy} string map. */
function asMap(raw: unknown): Record<string, NamedRoutingPolicy> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, NamedRoutingPolicy> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isValidRoutingPolicy(v)) {
      out[k] = v;
    }
  }
  return out;
}

/** The routing policy for `projectKey`, or undefined when unset. */
export function readPolicy(store: PolicyStore, projectKey: string): NamedRoutingPolicy | undefined {
  const map = asMap(store.read());
  return Object.hasOwn(map, projectKey) ? map[projectKey]! : undefined;
}

/**
 * Set (one of the 4 policies) or clear (undefined/empty/off/clear ⇒ delete the entry)
 * the routing policy for `projectKey`, preserving other projects' entries.
 */
export function writePolicy(store: PolicyStore, projectKey: string, policy: string | undefined): void {
  const map = asMap(store.read());
  if (typeof policy === 'string') {
    const cleaned = policy.trim().toLowerCase();
    if (cleaned === 'off' || cleaned === 'clear' || cleaned === 'none') {
      delete map[projectKey];
    } else if (isValidRoutingPolicy(cleaned)) {
      map[projectKey] = cleaned;
    }
  } else {
    delete map[projectKey];
  }
  store.write(map);
}
