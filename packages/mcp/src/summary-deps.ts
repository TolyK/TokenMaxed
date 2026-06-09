/**
 * Build a session-summary producer from the environment — the ONE place that wires
 * the real ledger, lane registry, policy, availability probe, core aggregates, and
 * manager selector into the pure {@link buildSummaryData}. Shared by the
 * router_summary server dep AND the SessionStart hook so both render identical data
 * from the same local sources (no MCP round-trip in the hook).
 *
 * Imports core at runtime (like the other adapter glue) — only ever loaded inside the
 * bundled server / hook, never by tools.ts (which must stay runtime-core-free).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { filterEventsSince, resolveLaneModel, staleAgainstPriceTable, summarize, tokenStats } from '@tokenmaxed/core';
import type { PriceTable } from '@tokenmaxed/core';
import { JsonlLedger, loadLaneConfig, loadPriceTable, readCliUsageByModel } from '@tokenmaxed/core/node';

import { makeAvailabilityProbe } from './availability.ts';
import { homeFile, makeLoadPolicy } from './config.ts';
import { reportFreshness } from './freshness-report.ts';
import { laneSetFingerprint, readLaneReviewState } from './lane-state.ts';
import { selectManagerLane } from './manager-select.ts';
import { readFreshnessCache } from './model-cache.ts';
import { buildSummaryData } from './summary.ts';
import type { SummaryData } from './summary.ts';
import { readEnabled } from './toggle.ts';

/** A read-only view of the toggle state file (mirrors fileToggleStore's read half). */
function readOnlyToggleStore(statePath: string) {
  return {
    read: () => {
      try {
        return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
      } catch {
        return {};
      }
    },
    write: () => {}, // summary never mutates the toggle
  };
}

/** Returns a producer of the current session summary, resolved from `env`. */
export function makeSummaryFromEnv(env: NodeJS.ProcessEnv): () => Promise<SummaryData> {
  const lanesPath = env.TOKENMAXED_LANES ?? homeFile('lanes.yaml');
  const ledgerPath = env.TOKENMAXED_LEDGER; // undefined ⇒ JsonlLedger default (~/.tokenmaxed)
  // Resolve state the SAME way the server + PreToolUse hook do: the SessionStart hook
  // does NOT inherit the mcpServers.env block, only CLAUDE_PLUGIN_DATA — so without
  // this fallback the hook would read a different state/cache dir than the server (the
  // /status writer) used, and never see the cached staleness.
  const statePath =
    env.TOKENMAXED_STATE ?? (env.CLAUDE_PLUGIN_DATA ? join(env.CLAUDE_PLUGIN_DATA, 'state.json') : homeFile('state.json'));
  const projectKey = env.TOKENMAXED_PROJECT ?? 'default';
  const gateReady = env.TOKENMAXED_GATE_READY === 'true';
  const globallyDisabled = env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true';
  const loadPolicy = makeLoadPolicy(env);
  const probeAvailable = makeAvailabilityProbe(env);
  const store = readOnlyToggleStore(statePath);

  // Match the server's price-table default (package-relative seed), so the staleness
  // the summary computes uses the SAME price table /status used to write the cache.
  const pricesPath = env.TOKENMAXED_PRICES ?? fileURLToPath(new URL('../prices.seed.json', import.meta.url));
  const cachePath = env.TOKENMAXED_MODEL_CACHE ?? join(dirname(statePath), 'model-freshness.json');
  // SETUP-1 B: lane-review state — same key + path setup uses, so the hint matches.
  const reviewProjectKey = env.TOKENMAXED_PROJECT ?? env.CLAUDE_PROJECT_DIR ?? 'default';
  const laneStatePath = env.TOKENMAXED_LANE_STATE ?? join(dirname(statePath), 'lane-review.json');

  return async () => {
    const lanes = existsSync(lanesPath) ? [...loadLaneConfig(lanesPath).lanes] : [];
    const available = await probeAvailable(lanes);
    const now = Date.now();
    // Load the price table once: it both resolves `<family>@latest` to the concrete
    // model the banner displays AND backs the egress-free latest-model check below.
    let priceTable: PriceTable | undefined;
    if (existsSync(pricesPath)) {
      try {
        priceTable = loadPriceTable(pricesPath);
      } catch {
        priceTable = undefined; // a missing/bad price table ⇒ display raw, skip staleness
      }
    }
    // Display the RESOLVED model (e.g. claude-opus@latest ⇒ claude-opus-4-8), so the
    // banner shows the concrete model in use rather than the alias. Falls back to the
    // raw lane when there is no price table (or the family isn't priced).
    const displayLanes = priceTable ? lanes.map((l) => resolveLaneModel(l, priceTable!)) : lanes;
    // "Are the latest models in use?" — checked at session start for EVERY lane kind
    // against the price table only (no /models egress). An `@latest` lane resolves to
    // the newest priced model so it's never flagged; a concrete pin that's behind the
    // newest priced model in its family IS flagged (incl. the CLI Claude lanes the
    // api-only live check never sees). This is the primary up-to-date signal.
    const staleByLane = new Map<string, { laneId: string; newest: string; newestPriced: boolean }>();
    if (!globallyDisabled && priceTable) {
      for (const f of staleAgainstPriceTable(lanes, priceTable)) {
        staleByLane.set(f.laneId, { laneId: f.laneId, newest: f.newest, newestPriced: true });
      }
      // Overlay the CACHE-ONLY live check (api lanes): it can report a newer model that
      // isn't priced yet (a pricing gap the price-table check can't see), so it takes
      // precedence per lane. refresh:false ⇒ never a /models call here; fetchList throws
      // to prove no egress on the session-start path.
      try {
        for (const w of await reportFreshness(
          lanes,
          {
            fetchList: () => {
              throw new Error('summary path must not fetch');
            },
            table: priceTable,
            now,
            readCache: () => readFreshnessCache(cachePath),
            writeCache: () => {},
          },
          { refresh: false },
        )) {
          staleByLane.set(w.laneId, { laneId: w.laneId, newest: w.newest, newestPriced: w.newestPriced });
        }
      } catch {
        /* a bad cache ⇒ keep the price-table findings already collected */
      }
    }
    const staleness = [...staleByLane.values()];
    // SETUP-1 B hint: read-only — compare the RAW lane fingerprint to what setup last
    // recorded for this project. NEVER write here (only /tokenmaxed:setup marks seen).
    let laneReview: 'first-review' | 'changed' | 'current' = 'current';
    if (lanes.length > 0) {
      const prior = readLaneReviewState(laneStatePath).byProject[reviewProjectKey]?.fingerprint;
      const fp = laneSetFingerprint(lanes);
      laneReview = prior === undefined ? 'first-review' : prior !== fp ? 'changed' : 'current';
    }
    return buildSummaryData({
      events: new JsonlLedger(ledgerPath).readAll(),
      lanes: displayLanes,
      policy: loadPolicy(),
      availableLaneIds: available,
      gateReady,
      enabled: globallyDisabled ? false : readEnabled(store, projectKey),
      now,
      core: { summarize, tokenStats, filterEventsSince },
      selectManager: selectManagerLane,
      staleness,
      laneReview,
      // Fold the host CLI's own per-model usage (real, transcript-derived) into the
      // per-lane counts. Best-effort: readCliUsageByModel fails open to {} so the
      // summary never breaks if transcripts are unreadable.
      cliUsageByModel: readCliUsageByModel(env.CLAUDE_PROJECT_DIR),
    });
  };
}
