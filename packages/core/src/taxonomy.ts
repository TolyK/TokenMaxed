/**
 * Runtime taxonomy registry — the seam that makes task categories
 * domain-pluggable. Phase 1 seeds a single `coding` domain whose WIRE form
 * stays BARE (e.g. `"bugfix"`). The namespaced CANONICAL form
 * (`"coding/bugfix"`) is internal only.
 *
 * Pure: no I/O. Importing this module self-registers the coding seed from
 * {@link TASK_CATEGORIES}.
 */

import { TASK_CATEGORIES } from './types.ts';

/** The coding domain id. */
export const CODING_DOMAIN = 'coding';

/** A domain and its wire (bare) category ids, in canonical order. */
export interface DomainSpec {
  /** Domain id, e.g. 'coding'. */
  domain: string;
  /** Wire (bare) category ids in canonical order for this domain. */
  categories: readonly string[];
}

/**
 * Thrown when a domain registration is invalid or would collide wire ids with
 * a different already-registered domain. Wire ids are globally unique in Phase 1.
 */
export class TaxonomyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxonomyError';
  }
}

/** Registration-order domain map: domain id → wire category list. */
const domains = new Map<string, readonly string[]>();
/** Global wire-id → owning domain (wire ids unique across domains). */
const wireOwner = new Map<string, string>();

/**
 * Register (or overwrite) a domain. Preserves registration order across
 * domains. Re-registering the same domain id is allowed (idempotent replace).
 *
 * Validates **atomically** (all checks before any mutation) and throws
 * {@link TaxonomyError} if:
 * - `domain` is empty or contains `'/'`
 * - any category is empty or contains `'/'`
 * - `categories` contains duplicates
 * - a wire category collides with an already-registered **different** domain
 *
 * A failed registration leaves the registry unchanged.
 */
export function registerDomain(spec: DomainSpec): void {
  const { domain, categories } = spec;

  // --- validation only (no mutation) ---
  if (domain === '' || domain.includes('/')) {
    throw new TaxonomyError(
      `Invalid domain id '${domain}': must be non-empty and must not contain '/'`,
    );
  }

  const seen = new Set<string>();
  for (const cat of categories) {
    if (cat === '' || cat.includes('/')) {
      throw new TaxonomyError(
        `Invalid category id '${cat}': must be non-empty and must not contain '/'`,
      );
    }
    if (seen.has(cat)) {
      throw new TaxonomyError(`Duplicate category id '${cat}' in domain '${domain}'`);
    }
    seen.add(cat);

    const owner = wireOwner.get(cat);
    if (owner !== undefined && owner !== domain) {
      throw new TaxonomyError(
        `Wire category '${cat}' is already registered by domain '${owner}'`,
      );
    }
  }

  // --- mutate only after all checks pass ---
  if (domains.has(domain)) {
    for (const cat of domains.get(domain)!) {
      if (wireOwner.get(cat) === domain) {
        wireOwner.delete(cat);
      }
    }
  }

  // Map.set on an existing key preserves insertion order.
  domains.set(domain, categories.slice());
  for (const cat of categories) {
    wireOwner.set(cat, domain);
  }
}

/**
 * Remove a domain from the registry and release its wire ids from the global
 * owner map (only ids still owned by that domain). No-op if unknown.
 */
export function unregisterDomain(domain: string): void {
  const cats = domains.get(domain);
  if (cats === undefined) return;

  for (const cat of cats) {
    if (wireOwner.get(cat) === domain) {
      wireOwner.delete(cat);
    }
  }
  domains.delete(domain);
}

/** Registered domain ids, in registration order. */
export function listDomains(): string[] {
  return [...domains.keys()];
}

/**
 * Wire ids for a domain, in order. Empty array if the domain is unknown.
 * Returns a defensive copy of the stored list.
 */
export function categoriesForDomain(domain: string): readonly string[] {
  const cats = domains.get(domain);
  return cats === undefined ? [] : cats.slice();
}

/**
 * All wire ids across all registered domains, in (domain registration order,
 * then category order). With only coding registered this deep-equals
 * `[...TASK_CATEGORIES]`.
 */
export function activeCategories(): string[] {
  const out: string[] = [];
  for (const cats of domains.values()) {
    out.push(...cats);
  }
  return out;
}

/** True iff `wireId` is a registered wire (bare) id. Canonical ids are not wire ids. */
export function isKnownCategory(wireId: string): boolean {
  return wireOwner.has(wireId);
}

/**
 * Owning domain for a wire id OR a canonical id. Returns `undefined` if unknown.
 */
export function domainOfCategory(id: string): string | undefined {
  if (isCanonical(id)) {
    const slash = id.indexOf('/');
    const domain = id.slice(0, slash);
    const category = id.slice(slash + 1);
    return wireOwner.get(category) === domain ? domain : undefined;
  }
  return wireOwner.get(id);
}

/**
 * True iff `id` contains exactly one `'/'` and both sides are non-empty.
 */
export function isCanonical(id: string): boolean {
  const first = id.indexOf('/');
  if (first <= 0) return false;
  if (id.indexOf('/', first + 1) !== -1) return false;
  if (first === id.length - 1) return false;
  return true;
}

/**
 * Wire → canonical. Already-canonical ids are returned unchanged. Unknown wire
 * ids pass through unchanged (never throw — old ledgers may hold retired ids).
 */
export function toCanonical(id: string): string {
  if (isCanonical(id)) return id;
  const domain = wireOwner.get(id);
  if (domain === undefined) return id;
  return `${domain}/${id}`;
}

/**
 * Canonical → wire. Already-wire ids are returned unchanged. Unknown ids pass
 * through unchanged (never throw).
 */
export function toWire(id: string): string {
  if (isCanonical(id)) {
    const slash = id.indexOf('/');
    const domain = id.slice(0, slash);
    const category = id.slice(slash + 1);
    if (wireOwner.get(category) === domain) return category;
    return id;
  }
  return id;
}

// Self-register coding from the types.ts seed so importing this module always
// has the coding domain available.
registerDomain({ domain: CODING_DOMAIN, categories: [...TASK_CATEGORIES] });
