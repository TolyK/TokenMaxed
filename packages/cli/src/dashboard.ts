/**
 * C — the local dashboard: the product's face, fully local-first.
 *
 * `buildDashboardData` assembles a JSON-serializable snapshot from the
 * content-free ledger + lane config (counts, ids, enums — never text), and
 * `renderDashboardHtml` turns it into ONE self-contained HTML file (inline
 * CSS/JS, zero network requests, file:// viewable). Nothing leaves the machine;
 * regenerating the file is the refresh model.
 *
 * HONESTY (law): every quota count is labeled the ROUTED share (the ledger
 * cannot see work done outside TokenMaxed); projections and estimated tokens
 * carry `est.`; the leaderboard shows its "passes your reviews, not ground
 * truth" caveat verbatim and its N.
 */

import {
  buildLeaderboard,
  filterEventsSince,
  laneDepletionForecast,
  laneQuotaState,
  outcomeStats,
  summarize,
  tokenStats,
} from '@tokenmaxed/core';
import type { Lane, LaneQuotaState, LeaderboardRow, LedgerEvent, TaskEvent } from '@tokenmaxed/core';

// --- data ------------------------------------------------------------------------

export interface DashboardWindow {
  label: '24h' | '7d' | 'lifetime';
  meteredAvoided: number;
  meteredSpent: number;
  offloads: number;
  tokens: number;
}

export interface DashboardQuotaAxis {
  axis: '5h window' | '7d requests' | '7d tokens';
  count: number;
  limit: number;
  /** used fraction of the limit (may exceed 1). */
  used: number;
  level: 'ok' | 'warn' | 'critical';
}

export interface DashboardLane {
  id: string;
  kind: string;
  model: string;
  trustMode: string;
  provenance: string;
  tokensRouted: number;
  quota: DashboardQuotaAxis[];
  /** B3 projection — present only at moderate confidence (relative ms). */
  forecastEtaMs?: number;
  /** true ⇒ a low-confidence projection exists (render a timeless notice). */
  forecastLow?: boolean;
}

export interface DashboardOutcomeRow {
  laneId: string;
  pass: number;
  needsRework: number;
  fail: number;
  successRate: number;
}

export interface DashboardRecentRow {
  tsIso: string;
  laneId: string;
  model: string;
  category: string;
  status: string;
  tokensIn: number;
  tokensOut: number;
  tokensEstimated: boolean;
  meteredSpent: number;
  superseded: boolean;
}

export interface DashboardData {
  generatedAtIso: string;
  windows: DashboardWindow[];
  lanes: DashboardLane[];
  leaderboard: LeaderboardRow[];
  outcomes: DashboardOutcomeRow[];
  recent: DashboardRecentRow[];
}

const RECENT_LIMIT = 30;

function quotaAxes(state: LaneQuotaState): DashboardQuotaAxis[] {
  const axes: DashboardQuotaAxis[] = [];
  if (state.window) axes.push({ axis: '5h window', ...state.window });
  if (state.weekRequests) axes.push({ axis: '7d requests', ...state.weekRequests });
  if (state.weekTokens) axes.push({ axis: '7d tokens', ...state.weekTokens });
  return axes;
}

/** Pure snapshot assembly (clock injected; deterministic for the same inputs). */
export function buildDashboardData(events: readonly LedgerEvent[], lanes: readonly Lane[], now: number): DashboardData {
  const windowFor = (label: DashboardWindow['label'], sinceMs?: number): DashboardWindow => {
    const slice = sinceMs === undefined ? events : filterEventsSince(events, new Date(now - sinceMs).toISOString());
    const s = summarize(slice);
    const t = tokenStats(slice);
    return {
      label,
      meteredAvoided: s.savings.metered_avoided,
      meteredSpent: s.savings.metered_spent,
      offloads: s.events,
      tokens: t.total.total,
    };
  };

  const byLaneTokens = tokenStats(events).byLane;
  const dashLanes: DashboardLane[] = lanes.map((l) => {
    const state = laneQuotaState(events, l, now);
    const axes = quotaAxes(state);
    const pressured = axes.some((a) => a.level !== 'ok');
    const forecast = pressured ? laneDepletionForecast(events, l, now) : undefined;
    return {
      id: l.id,
      kind: l.kind,
      model: l.model,
      trustMode: l.trust_mode,
      provenance: l.provenance,
      tokensRouted: byLaneTokens[l.id]?.total ?? 0,
      quota: axes,
      ...(forecast
        ? forecast.confidence === 'moderate'
          ? { forecastEtaMs: forecast.etaMs }
          : { forecastLow: true }
        : {}),
    };
  });

  const outcomes = outcomeStats(events);
  const outcomeRows: DashboardOutcomeRow[] = Object.entries(outcomes.byLane)
    .map(([laneId, g]) => ({
      laneId,
      pass: g.pass,
      needsRework: g.needs_rework,
      fail: g.fail,
      successRate: g.success_rate,
    }))
    .sort((a, b) => (a.laneId < b.laneId ? -1 : 1));

  const recent: DashboardRecentRow[] = events
    .filter((e): e is TaskEvent => e.event_type === 'task' && e.status !== 'native')
    .slice(-RECENT_LIMIT)
    .reverse()
    .map((e) => ({
      tsIso: e.ts,
      laneId: e.laneId,
      model: e.model,
      category: e.category,
      status: e.status,
      tokensIn: e.tokens_in,
      tokensOut: e.tokens_out,
      tokensEstimated: e.tokens_estimated,
      meteredSpent: e.metered_spent,
      superseded: e.superseded === true,
    }));

  return {
    generatedAtIso: new Date(now).toISOString(),
    windows: [windowFor('24h', 24 * 3600_000), windowFor('7d', 7 * 24 * 3600_000), windowFor('lifetime')],
    lanes: dashLanes,
    leaderboard: buildLeaderboard(events),
    outcomes: outcomeRows,
    recent,
  };
}

// --- rendering --------------------------------------------------------------------

/** Leaderboard caveat — MUST render verbatim (P6 §6.5 honesty bar). */
export const LEADERBOARD_CAVEAT = 'This measures who passes real reviews at difficulty D, not ground-truth capability.';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function usd(n: number): string {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
}

function int(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function fmtEtaMs(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 0.75) return 'now';
  if (minutes < 90) return `~${Math.max(1, Math.round(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 36) return `~${Math.round(hours)}h`;
  return `~${Math.round(hours / 24)}d`;
}

const LEVEL_LABEL = { ok: 'OK', warn: '⚠ WARN', critical: '🛑 CRITICAL' } as const;

function meter(a: DashboardQuotaAxis): string {
  const pct = Math.min(100, Math.round(a.used * 100));
  return `
    <div class="meter">
      <div class="meter-head"><span>${esc(a.axis)}</span><span class="lvl lvl-${a.level}">${LEVEL_LABEL[a.level]}</span></div>
      <div class="track"><div class="fill fill-${a.level}" style="width:${pct}%"></div></div>
      <div class="meter-foot">${int(a.count)}/${int(a.limit)} routed · ${pct}% of limit</div>
    </div>`;
}

function laneCard(l: DashboardLane): string {
  const forecast =
    l.forecastEtaMs !== undefined
      ? `<div class="forecast">est. ${esc(fmtEtaMs(l.forecastEtaMs))} to cap at routed pace</div>`
      : l.forecastLow
        ? '<div class="forecast">approaching cap (routed)</div>'
        : '';
  return `
    <div class="card">
      <div class="card-title">${esc(l.id)} <span class="muted">${esc(l.kind)} · ${esc(l.model)} · trust=${esc(l.trustMode)}</span></div>
      ${l.quota.length > 0 ? l.quota.map(meter).join('') : '<div class="muted">no quota configured</div>'}
      ${forecast}
      <div class="meter-foot">${int(l.tokensRouted)} tokens routed (lifetime)</div>
    </div>`;
}

function leaderboardTable(rows: readonly LeaderboardRow[]): string {
  const body = rows
    .map(
      (r) => `
      <tr>
        <td>${esc(r.model)}</td><td>${esc(r.category)}</td><td>${esc(r.difficulty)}</td>
        <td data-n="${r.passRate}">${(r.passRate * 100).toFixed(0)}%</td>
        <td data-n="${r.pass}">${int(r.pass)}</td><td data-n="${r.needs_rework}">${int(r.needs_rework)}</td><td data-n="${r.fail}">${int(r.fail)}</td>
        <td data-n="${r.tokens_in + r.tokens_out}">${int(r.tokens_in + r.tokens_out)}</td>
        <td data-n="${r.users}">${int(r.users)}</td>
      </tr>`,
    )
    .join('');
  return `
    <table class="sortable" id="leaderboard">
      <thead><tr>
        <th>model</th><th>category</th><th>difficulty</th><th>pass rate</th>
        <th>pass</th><th>rework</th><th>fail</th><th>tokens</th><th>N</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

/** Render the whole dashboard as one self-contained HTML document. */
export function renderDashboardHtml(data: DashboardData): string {
  const tiles = data.windows
    .map(
      (w) => `
      <div class="tile">
        <div class="tile-label">${esc(w.label)}</div>
        <div class="tile-value">${usd(w.meteredAvoided)}</div>
        <div class="tile-sub">est. metered avoided</div>
        <div class="tile-sub">spent ${usd(w.meteredSpent)} metered · ${int(w.offloads)} offloads · ${int(w.tokens)} tok</div>
      </div>`,
    )
    .join('');

  const outcomes = data.outcomes
    .map(
      (o) => `
      <tr><td>${esc(o.laneId)}</td><td data-n="${o.pass}">${int(o.pass)}</td><td data-n="${o.needsRework}">${int(o.needsRework)}</td>
      <td data-n="${o.fail}">${int(o.fail)}</td><td data-n="${o.successRate}">${(o.successRate * 100).toFixed(0)}%</td></tr>`,
    )
    .join('');

  const recent = data.recent
    .map(
      (e) => `
      <tr><td>${esc(e.tsIso.replace('T', ' ').slice(0, 16))}</td><td>${esc(e.laneId)}</td><td>${esc(e.model)}</td>
      <td>${esc(e.category)}</td><td>${esc(e.status)}${e.superseded ? ' (superseded)' : ''}</td>
      <td data-n="${e.tokensIn + e.tokensOut}">${int(e.tokensIn)} / ${int(e.tokensOut)}${e.tokensEstimated ? ' est.' : ''}</td>
      <td data-n="${e.meteredSpent}">${usd(e.meteredSpent)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TokenMaxed — local dashboard</title>
<style>
:root{--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--line:#e4e3df;--good:#0ca30c;--warn:#fab219;--crit:#d03b3b;}
@media (prefers-color-scheme: dark){:root{--surface:#1a1a19;--ink:#ffffff;--ink-2:#c3c2b7;--line:#3a3936;}}
*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,sans-serif;padding:24px;max-width:1100px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 10px}
.muted{color:var(--ink-2);font-weight:400;font-size:12px}
.honesty{color:var(--ink-2);font-size:12px;margin:2px 0 18px}
.tiles{display:flex;gap:12px;flex-wrap:wrap}
.tile{border:1px solid var(--line);border-radius:8px;padding:12px 16px;min-width:200px;flex:1}
.tile-label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)}
.tile-value{font-size:26px;font-weight:600;margin:2px 0}
.tile-sub{font-size:12px;color:var(--ink-2)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.card{border:1px solid var(--line);border-radius:8px;padding:12px 16px}
.card-title{font-weight:600;margin-bottom:8px}
.meter{margin:8px 0}
.meter-head{display:flex;justify-content:space-between;font-size:12px}
.lvl{font-weight:600}.lvl-ok{color:var(--good)}.lvl-warn{color:var(--warn)}.lvl-critical{color:var(--crit)}
.track{height:8px;border-radius:4px;background:var(--line);overflow:hidden;margin:4px 0}
.fill{height:100%;border-radius:4px}
.fill-ok{background:var(--good)}.fill-warn{background:var(--warn)}.fill-critical{background:var(--crit)}
.meter-foot,.forecast{font-size:12px;color:var(--ink-2)}
.forecast{margin-top:4px;font-style:italic}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}
th{color:var(--ink-2);font-weight:600;font-size:12px;cursor:pointer;user-select:none;white-space:nowrap}
th.sorted-asc::after{content:" ↑"}th.sorted-desc::after{content:" ↓"}
.wrap{overflow-x:auto}
footer{margin-top:28px;color:var(--ink-2);font-size:12px}
</style></head><body>
<h1>TokenMaxed — local dashboard</h1>
<div class="honesty">Generated ${esc(data.generatedAtIso)} · all data is local (content-free ledger) · quota counts are the <strong>routed share</strong> recorded by TokenMaxed — never your total subscription usage · regenerate with <code>tokenmaxed dashboard</code></div>

<h2>Savings <span class="muted">(honest net: delivered-work baseline minus ALL metered spend)</span></h2>
<div class="tiles">${tiles}</div>

<h2>Quota <span class="muted">(routed share only)</span></h2>
<div class="cards">${data.lanes.map(laneCard).join('')}</div>

<h2>Leaderboard <span class="muted">(real reviewed usage · N = contributing users)</span></h2>
<div class="honesty">${esc(LEADERBOARD_CAVEAT)}</div>
<div class="wrap">${leaderboardTable(data.leaderboard)}</div>

<h2>Review outcomes <span class="muted">(per lane)</span></h2>
<div class="wrap"><table class="sortable"><thead><tr><th>lane</th><th>pass</th><th>rework</th><th>fail</th><th>success</th></tr></thead><tbody>${outcomes}</tbody></table></div>

<h2>Recent offloads <span class="muted">(last ${data.recent.length}, newest first)</span></h2>
<div class="wrap"><table class="sortable"><thead><tr><th>time (UTC)</th><th>lane</th><th>model</th><th>category</th><th>status</th><th>tok in/out</th><th>metered</th></tr></thead><tbody>${recent}</tbody></table></div>

<footer>TokenMaxed · local-first: this file was generated on your machine from your ledger; it makes no network requests.</footer>
<script>
// Click-to-sort for .sortable tables (numeric via data-n, else text). No deps.
for (const table of document.querySelectorAll('table.sortable')) {
  const ths = table.querySelectorAll('th');
  ths.forEach((th, col) => th.addEventListener('click', () => {
    const tbody = table.tBodies[0];
    const dir = th.classList.contains('sorted-desc') ? 1 : -1;
    ths.forEach((h) => h.classList.remove('sorted-asc', 'sorted-desc'));
    th.classList.add(dir === 1 ? 'sorted-asc' : 'sorted-desc');
    const key = (tr) => {
      const cell = tr.children[col];
      return cell.dataset.n !== undefined ? Number(cell.dataset.n) : cell.textContent.trim().toLowerCase();
    };
    [...tbody.rows]
      .sort((a, b) => { const ka = key(a), kb = key(b); return (ka < kb ? -1 : ka > kb ? 1 : 0) * dir; })
      .forEach((tr) => tbody.appendChild(tr));
  }));
}
</script>
</body></html>
`;
}
