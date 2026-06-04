/**
 * Freshness orchestration: for each eligible api lane, get its vendor model list
 * (live with cache write, or cache-only) and assess whether the pinned model is
 * stale. The pure assessment lives in core (assessStaleness); the egress + cache
 * are injected so this is testable without network or disk. WARN-only — it never
 * changes routing (that's the @latest resolver, a later commit).
 *
 * Eligibility (gate/enabled/key) is the CALLER's job — it passes only the lanes to
 * check. Here we just resolve each lane's model list and compare.
 */

import { assessStaleness, parseModelAlias } from '@tokenmaxed/core';
import type { Lane, PriceTable } from '@tokenmaxed/core';

import { getEntry, putEntry } from './model-cache.ts';
import type { FreshnessCache } from './model-cache.ts';
import type { ModelListResult } from './model-list.ts';

/** A single stale-lane finding, surfaced to the user (setup/status/summary). */
export interface StalenessWarning {
  laneId: string;
  family: string;
  pinned: string;
  newest: string;
  /** False ⇒ a newer model exists but TokenMaxed can't price it yet (pricing gap). */
  newestPriced: boolean;
}

export interface FreshnessDeps {
  fetchList: (lane: Lane) => Promise<ModelListResult>;
  table: PriceTable;
  now: number;
  readCache: () => FreshnessCache;
  writeCache: (cache: FreshnessCache) => void;
}

/**
 * Assess staleness for each lane with a concrete, family-tagged pinned model. A
 * `<family>@latest` alias is skipped here (it tracks latest by definition — the
 * resolver handles it). Returns one warning per stale lane.
 *   - `refresh:true`  ⇒ a live `/models` query (and cache write) per lane.
 *   - `refresh:false` ⇒ STRICTLY cache-only — never makes a network call (this is
 *     the session-start/summary path; passive egress is not allowed there).
 */
export async function reportFreshness(
  lanes: readonly Lane[],
  deps: FreshnessDeps,
  opts: { refresh: boolean },
): Promise<StalenessWarning[]> {
  let cache = deps.readCache();
  const warnings: StalenessWarning[] = [];

  for (const lane of lanes) {
    if (lane.kind !== 'api' || !lane.endpoint) continue;
    const spec = parseModelAlias(lane.model);
    if (spec.latest) continue; // @latest tracks the newest by definition — not "stale"
    const family = lane.model_family;
    if (!family) continue; // no explicit family ⇒ we don't guess; nothing to compare

    let models = getEntry(cache, lane.endpoint)?.models ?? [];
    if (opts.refresh) {
      const result = await deps.fetchList(lane);
      if (result.status === 'ok' || result.status === 'ok-empty') {
        models = result.status === 'ok' ? result.models : [];
        cache = putEntry(cache, lane.endpoint, models, deps.now);
        deps.writeCache(cache);
      }
      // offline/timeout/auth-missing/etc ⇒ keep whatever the cache had (models above).
    }

    const report = assessStaleness(spec.id, family, models, deps.table);
    if (report.status === 'stale') {
      warnings.push({ laneId: lane.id, family, pinned: spec.id, newest: report.newest, newestPriced: report.newestPriced });
    }
  }
  return warnings;
}

/** Render warnings as human lines for setup/status output. Empty ⇒ []. */
export function renderStalenessWarnings(warnings: readonly StalenessWarning[]): string[] {
  return warnings.map((w) =>
    w.newestPriced
      ? `  ⚠ ${w.laneId}: using ${w.pinned}; newer available: ${w.newest} (set model: ${w.family}@latest, or pin ${w.newest})`
      : `  ⚠ ${w.laneId}: using ${w.pinned}; newer ${w.newest} exists but isn't priced yet — add it to the price table to route it`,
  );
}
