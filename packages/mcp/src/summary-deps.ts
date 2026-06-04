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

import { filterEventsSince, summarize, tokenStats } from '@tokenmaxed/core';
import { JsonlLedger, loadLaneConfig, loadPriceTable } from '@tokenmaxed/core/node';

import { makeAvailabilityProbe } from './availability.ts';
import { homeFile, makeLoadPolicy } from './config.ts';
import { reportFreshness } from './freshness-report.ts';
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

  return async () => {
    const lanes = existsSync(lanesPath) ? [...loadLaneConfig(lanesPath).lanes] : [];
    const available = await probeAvailable(lanes);
    const now = Date.now();
    // Staleness for the banner is CACHE-ONLY (refresh:false) — the summary/session
    // start path must never make a /models call. The cache is populated by the
    // explicit, networked /tokenmaxed:status. fetchList throws to prove no egress.
    let staleness: { laneId: string; newest: string; newestPriced: boolean }[] = [];
    if (!globallyDisabled && existsSync(pricesPath)) {
      try {
        staleness = await reportFreshness(
          lanes,
          {
            fetchList: () => {
              throw new Error('summary path must not fetch');
            },
            table: loadPriceTable(pricesPath),
            now,
            readCache: () => readFreshnessCache(cachePath),
            writeCache: () => {},
          },
          { refresh: false },
        );
      } catch {
        staleness = []; // a missing/bad price table or cache ⇒ just omit staleness
      }
    }
    return buildSummaryData({
      events: new JsonlLedger(ledgerPath).readAll(),
      lanes,
      policy: loadPolicy(),
      availableLaneIds: available,
      gateReady,
      enabled: globallyDisabled ? false : readEnabled(store, projectKey),
      now,
      core: { summarize, tokenStats, filterEventsSince },
      selectManager: selectManagerLane,
      staleness,
    });
  };
}
