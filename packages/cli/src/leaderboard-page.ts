/**
 * D — the standalone leaderboard page: ONE self-contained static HTML document
 * (inline CSS/JS, zero network) that renders identically from a local N=1
 * aggregate today and, unchanged, from a densified cross-user aggregate when
 * the hosted endpoint ships — the page IS the Vercel artifact, just fed a
 * different JSON.
 *
 * Modes (honesty):
 *  - 'local': YOUR data, unsuppressed, loudly labeled N=1/local — because it
 *    never leaves the machine, suppression does not apply.
 *  - 'published': ONLY cells that clear MIN_USERS distinct contributors and
 *    MIN_TOTAL verdicts (k-anonymity is a property of publication).
 * Both modes render the P6 caveat verbatim and show N on every row.
 */

import { MIN_TOTAL, MIN_USERS, publishLeaderboard } from '@tokenmaxed/core';
import type { MergedCell } from '@tokenmaxed/core';

export const LEADERBOARD_CAVEAT = 'This measures who passes real reviews at difficulty D, not ground-truth capability.';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function int(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export interface LeaderboardPageOptions {
  mode: 'local' | 'published';
  generatedAtIso: string;
}

/** Dogfood success scale — identical to core's leaderboard passRate. */
function passRate(c: MergedCell): number {
  const total = c.pass + c.needs_rework + c.fail;
  return total === 0 ? 0 : (c.pass + 0.5 * c.needs_rework) / total;
}

export function renderLeaderboardPage(cells: readonly MergedCell[], opts: LeaderboardPageOptions): string {
  // Published mode ENFORCES suppression internally — no caller can render a
  // thin cell under the published banner, whatever it passes in.
  const shown = opts.mode === 'published' ? publishLeaderboard(cells) : cells;
  const banner =
    opts.mode === 'local'
      ? 'LOCAL VIEW — your own ledger only (N=1). This page was generated on your machine and nothing has been uploaded; the published view suppresses any cell with fewer than ' +
        `${MIN_USERS} contributing users and ${MIN_TOTAL} verdicts.`
      : `PUBLISHED VIEW — every cell aggregates ≥ ${MIN_USERS} distinct contributors and ≥ ${MIN_TOTAL} verdicts (thinner cells are withheld, not shown).`;

  const body = shown
    .map(
      (c) => `
      <tr>
        <td>${esc(c.model)}</td><td>${esc(c.category)}</td><td>${esc(c.difficulty)}</td>
        <td data-n="${passRate(c)}">${(passRate(c) * 100).toFixed(0)}%</td>
        <td data-n="${c.pass}">${int(c.pass)}</td><td data-n="${c.needs_rework}">${int(c.needs_rework)}</td><td data-n="${c.fail}">${int(c.fail)}</td>
        <td data-n="${c.tokens_in + c.tokens_out}">${int(c.tokens_in + c.tokens_out)}</td>
        <td data-n="${c.users}">${int(c.users)}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TokenMaxed — real-usage leaderboard</title>
<style>
:root{--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--line:#e4e3df;}
@media (prefers-color-scheme: dark){:root{--surface:#1a1a19;--ink:#ffffff;--ink-2:#c3c2b7;--line:#3a3936;}}
*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,sans-serif;padding:24px;max-width:900px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}
.honesty{color:var(--ink-2);font-size:12px;margin:2px 0 10px}
.mode{border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:12px;color:var(--ink-2);margin-bottom:16px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}
th{color:var(--ink-2);font-weight:600;font-size:12px;cursor:pointer;user-select:none;white-space:nowrap}
th.sorted-asc::after{content:" ↑"}th.sorted-desc::after{content:" ↓"}
.wrap{overflow-x:auto}
footer{margin-top:24px;color:var(--ink-2);font-size:12px}
.empty{color:var(--ink-2);padding:24px 0}
</style></head><body>
<h1>TokenMaxed — real-usage leaderboard</h1>
<div class="honesty">${esc(LEADERBOARD_CAVEAT)} Built ONLY from aggregate counts of routed-and-reviewed work — never per-task rows, never code or prompt text. Generated ${esc(opts.generatedAtIso)}.</div>
<div class="mode">${esc(banner)}</div>
${
  shown.length === 0
    ? `<div class="empty">${opts.mode === 'published' ? `No cell clears the publication bar yet (≥ ${MIN_USERS} users, ≥ ${MIN_TOTAL} verdicts).` : 'No reviewed offloads recorded yet — route some work first.'}</div>`
    : `<div class="wrap"><table class="sortable"><thead><tr>
<th>model</th><th>category</th><th>difficulty</th><th>pass rate</th><th>pass</th><th>rework</th><th>fail</th><th>tokens</th><th>N</th>
</tr></thead><tbody>${body}</tbody></table></div>`
}
<footer>Pass rate = (pass + ½·rework) / total — the same scale routing learns from. N = distinct contributing users per row.</footer>
<script>
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
