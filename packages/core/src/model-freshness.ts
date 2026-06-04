/**
 * Model-freshness primitives (pure, no I/O). The bug these address: a lane's
 * `model` is a static string set once and never reconciled against the vendor's
 * family, so it silently goes stale (e.g. `minimax-m2` while the family advanced to
 * `minimax-m3`). These helpers support a `<family>@latest` alias and staleness
 * detection, with EXPLICIT family metadata (never inferred from an id by prefix —
 * `gpt-4` vs `gpt-4o` etc. make that unsafe).
 *
 * The host adapter does the network `/models` query and feeds concrete data in;
 * this module only decides things from values, so it stays unit-testable.
 */

import type { PriceTable } from './price.ts';

/** A parsed `model` field: either a concrete id, or a `<family>@latest` alias. */
export type ModelSpec =
  | { latest: false; id: string }
  | { latest: true; family: string };

/**
 * Parse a lane's `model` string. `"<family>@latest"` ⇒ a latest-in-family alias;
 * anything else ⇒ a concrete id. The family is the literal stem before `@latest`
 * (explicit — we never guess a family from a concrete id here).
 */
export function parseModelAlias(model: string): ModelSpec {
  const m = /^(.+)@latest$/.exec(model.trim());
  if (m && m[1]!.trim() !== '') return { latest: true, family: m[1]!.trim() };
  return { latest: false, id: model };
}

/**
 * Natural version comparison of two model ids: split into numeric and non-numeric
 * runs and compare run-by-run so `m2 < m2.5 < m3 < m10`. Purely lexical fallback
 * ordering used ONLY when no release date is available; returns <0, 0, or >0.
 */
export function compareModelVersion(a: string, b: string): number {
  const runs = (s: string) => s.toLowerCase().match(/(\d+|\D+)/g) ?? [];
  const ra = runs(a);
  const rb = runs(b);
  const n = Math.max(ra.length, rb.length);
  for (let i = 0; i < n; i++) {
    const xa = ra[i];
    const xb = rb[i];
    if (xa === undefined) return -1; // a is a prefix of b ⇒ a is "older/smaller"
    if (xb === undefined) return 1;
    const na = /^\d+$/.test(xa);
    const nb = /^\d+$/.test(xb);
    if (na && nb) {
      const d = Number.parseInt(xa, 10) - Number.parseInt(xb, 10);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

/** Release-time of a priced model (epoch ms), or undefined when no `released` is set. */
function releasedMs(table: PriceTable, id: string): number | undefined {
  const r = table.models[id]?.released;
  return r === undefined ? undefined : Date.parse(r);
}

/** Order two same-family model ids newest-first: by `released` when both have it, else version. */
export function compareNewestFirst(table: PriceTable, a: string, b: string): number {
  const ta = releasedMs(table, a);
  const tb = releasedMs(table, b);
  if (ta !== undefined && tb !== undefined && ta !== tb) return tb - ta; // newer first
  return compareModelVersion(b, a); // higher version first
}

/** The priced model ids in `family` (exact `family` metadata match — no guessing). */
export function pricedIdsInFamily(table: PriceTable, family: string): string[] {
  return Object.keys(table.models).filter((id) => table.models[id]!.family === family);
}

/**
 * The newest priced model in `family` (by `released`, else version), or undefined if
 * the table has no priced model tagged with that family. This is the deterministic,
 * pricing-safe fallback for `<family>@latest` when the live `/models` list is
 * unavailable — and the floor a resolved `@latest` must stay at least as new as.
 */
export function newestPricedInFamily(table: PriceTable, family: string): string | undefined {
  const ids = pricedIdsInFamily(table, family);
  if (ids.length === 0) return undefined;
  return [...ids].sort((a, b) => compareNewestFirst(table, a, b))[0];
}

/**
 * Resolve a lane whose `model` is a `<family>@latest` alias to a concrete, PRICED
 * model id (the newest priced model in that family). Pure + egress-free: an unpriced
 * model can't route anyway (it has no price for the savings math), so the price table
 * IS the set of resolvable models — the live `/models` list only drives the staleness
 * warning that prompts adding a newer model's price. A concrete (non-alias) lane is
 * returned unchanged; an alias with no priced family member is returned UNCHANGED
 * (still `@latest`), so the normal unpriceable-lane filter excludes it (caller warns).
 */
export function resolveLaneModel<L extends { model: string }>(lane: L, table: PriceTable): L {
  const spec = parseModelAlias(lane.model);
  if (!spec.latest) return lane;
  const concrete = newestPricedInFamily(table, spec.family);
  return concrete ? { ...lane, model: concrete } : lane;
}

/** A model id (optionally with a vendor `created` epoch) for family matching. */
export interface FamilyModel {
  id: string;
  created?: number;
}

/**
 * Whether `id` belongs to the EXPLICIT `family`: an exact match, or `family` followed
 * by a non-alphanumeric boundary (so "minimax" matches "minimax-m3" but NOT "minimaxx").
 * The family is always provided by the caller (from `model_family` or a `@latest`
 * alias stem) — we never infer it from an id.
 */
export function sameFamily(id: string, family: string): boolean {
  if (id === family) return true;
  if (!id.startsWith(family)) return false;
  const next = id.charAt(family.length);
  return next !== '' && !/[a-z0-9]/i.test(next);
}

/** Staleness of a pinned model vs the vendor's live same-family list. */
export type StalenessReport =
  | { status: 'fresh' }
  | { status: 'unknown' } // no same-family model in the remote list ⇒ can't judge
  | { status: 'stale'; newest: string; newestPriced: boolean };

/**
 * Compare a pinned `model` against the newest same-family model the vendor reports.
 * `stale` ⇒ a newer same-family model exists (with whether TokenMaxed can price it —
 * an unpriced newer model is a pricing-gap to surface, not auto-adopt). Ordering uses
 * `created` when both have it, else the natural version comparator. Never throws.
 */
export function assessStaleness(
  pinnedId: string,
  family: string,
  remote: readonly FamilyModel[],
  table: PriceTable,
): StalenessReport {
  const fam = remote.filter((m) => sameFamily(m.id, family));
  if (fam.length === 0) return { status: 'unknown' };
  const newest = [...fam].sort((a, b) =>
    a.created !== undefined && b.created !== undefined && a.created !== b.created
      ? b.created - a.created
      : compareModelVersion(b.id, a.id),
  )[0]!;
  if (newest.id === pinnedId) return { status: 'fresh' };
  const pinned = fam.find((m) => m.id === pinnedId);
  const newer =
    pinned?.created !== undefined && newest.created !== undefined
      ? newest.created > pinned.created
      : compareModelVersion(newest.id, pinnedId) > 0;
  if (!newer) return { status: 'fresh' };
  return { status: 'stale', newest: newest.id, newestPriced: Object.hasOwn(table.models, newest.id) };
}
