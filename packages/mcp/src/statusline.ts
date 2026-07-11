#!/usr/bin/env node
/**
 * A3 — statusline quota gauge. Prints ONE compact line for Claude Code's
 * `statusLine` command: metered $ avoided (7d, honest "est." label) and the
 * tightest routed-5h request window across lanes that declare
 * `requests_per_window` (P4's window quota — ledger-only counts, so it is the
 * ROUTED share of the window, never claimed as total subscription usage).
 *
 * FAST BY CONSTRUCTION — statuslines refresh constantly, so unlike the
 * SessionStart banner this reads ONLY small local files (lanes.yaml +
 * ledger.jsonl + settings.json defaults): no availability probes, no freshness
 * calls, no network, no stdin read. Fails OPEN (prints nothing, exit 0) on any error and stays
 * SILENT under the kill-switch, so a broken config can never wedge the host's
 * status bar. Content-free output: lane ids + numbers only.
 *
 * Wire-up (user settings):
 *   "statusLine": { "type": "command",
 *     "command": "node /ABS/PATH/TO/packages/plugin/statusline.mjs" }
 */

import { existsSync } from 'node:fs';

import { FIVE_HOUR_MS, filterEventsSince, laneDepletionForecast, requestsInWindow, summarize, windowLevel, windowUsedFraction } from '@tokenmaxed/core';
import type { Lane, LedgerEvent, WindowLevel } from '@tokenmaxed/core';
import { JsonlLedger, loadLaneConfig } from '@tokenmaxed/core/node';

import { homeFile } from './config.ts';
import { effectiveEnv } from './settings.ts';
import { fmtEta, fmtWindow } from './summary.ts';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** The gauge's data, computed pure so tests can drive it with synthetic inputs. */
export interface StatuslineData {
  /** Estimated metered $ avoided over the trailing 7 days. */
  avoided7dUsd: number;
  /** The tightest configured rolling window (highest used fraction), if any lane declares one. */
  window?: {
    laneId: string;
    count: number;
    limit: number;
    level: WindowLevel;
    windowHours?: number;
    /** B3: projected ms to depletion at routed pace — set ONLY at warn/critical + moderate confidence. */
    etaMs?: number;
  };
  /** True when the ledger has no task events yet. */
  empty: boolean;
}

/** Pure: compute the gauge from ledger events + lanes as of `now` (epoch ms). */
export function buildStatuslineData(events: readonly LedgerEvent[], lanes: readonly Lane[], now: number): StatuslineData {
  const summary = summarize(filterEventsSince(events, new Date(now - SEVEN_DAYS_MS).toISOString()));
  // Empty means no ROUTED work yet — a native breadcrumb (no lane ran) doesn't
  // make the gauge claim activity, matching the window counts below.
  const empty = !events.some((e) => e.event_type === 'task' && e.status !== 'native');

  // Routed task timestamps per lane (native breadcrumbs are not routed requests).
  const tsByLane = new Map<string, number[]>();
  for (const e of events) {
    if (e.event_type !== 'task' || e.status === 'native') continue;
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) continue;
    (tsByLane.get(e.laneId) ?? tsByLane.set(e.laneId, []).get(e.laneId)!).push(ts);
  }

  let window: StatuslineData['window'];
  let worstLane: Lane | undefined;
  let worstFraction = -1;
  for (const lane of lanes) {
    const limit = lane.requests_per_window;
    if (!(typeof limit === 'number' && limit > 0)) continue;
    // B: honor a configured window_ms override (parity with quota state + summary).
    const windowMs = typeof lane.window_ms === 'number' && lane.window_ms > 0 ? lane.window_ms : FIVE_HOUR_MS;
    const count = requestsInWindow(tsByLane.get(lane.id) ?? [], now, windowMs);
    const fraction = windowUsedFraction(count, limit);
    if (fraction > worstFraction) {
      worstFraction = fraction;
      worstLane = lane;
      window = {
        laneId: lane.id,
        count,
        limit,
        level: windowLevel(fraction),
        ...(windowMs !== FIVE_HOUR_MS ? { windowHours: windowMs / 3_600_000 } : {}),
      };
    }
  }
  // B3: a time renders ONLY at warn/critical + moderate confidence (plan §1.4);
  // low-confidence projections stay silent here — the ⚠/🛑 marker already warns.
  if (window && worstLane && (window.level === 'warn' || window.level === 'critical')) {
    const forecast = laneDepletionForecast(events, worstLane, now);
    if (forecast?.confidence === 'moderate') window.etaMs = forecast.etaMs;
  }

  return { avoided7dUsd: summary.savings.metered_avoided, ...(window ? { window } : {}), empty };
}

/** Pure: render the single statusline string. */
export function formatStatusline(d: StatuslineData): string {
  if (d.empty) return 'tmax · no routed tasks yet';
  const parts = [`tmax · est. $${d.avoided7dUsd.toFixed(2)} metered avoided (7d)`];
  if (d.window) {
    const marker = d.window.level === 'critical' ? ' 🛑' : d.window.level === 'warn' ? ' ⚠' : '';
    const label = d.window.windowHours !== undefined ? fmtWindow(d.window.windowHours * 3_600_000) : '5h';
    const eta = d.window.etaMs !== undefined ? ` → est. ${fmtEta(d.window.etaMs)} (routed-only)` : '';
    parts.push(`${label} ${d.window.laneId} ${d.window.count}/${d.window.limit} routed${marker}${eta}`);
  }
  return parts.join(' · ');
}

/** I/O wrapper: read lanes + ledger from the env-resolved paths and render. */
export function statuslineFromEnv(env: NodeJS.ProcessEnv, now: number = Date.now()): string {
  const lanesPath = env.TOKENMAXED_LANES ?? homeFile('lanes.yaml');
  const lanes: readonly Lane[] = existsSync(lanesPath) ? loadLaneConfig(lanesPath).lanes : [];
  const events = new JsonlLedger(env.TOKENMAXED_LEDGER).readAll();
  return formatStatusline(buildStatuslineData(events, lanes, now));
}

/** Entry body (called by statusline-main.ts, the bundled entrypoint). */
export async function statuslineMain(): Promise<void> {
  // A4 entrypoint wrap: settings.json fills unset flag vars (a third tiny local
  // file read — still no probes/network), so /tokenmaxed:config claims hold for
  // this surface too. Kill-switch stays env-only by design.
  const env = effectiveEnv(process.env);
  if (env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true') return; // silent under kill-switch
  let line: string;
  try {
    line = statuslineFromEnv(env);
  } catch {
    return; // fail open — an unreadable config/ledger must never wedge the status bar
  }
  await new Promise<void>((resolve) => process.stdout.write(`${line}\n`, () => resolve()));
}
