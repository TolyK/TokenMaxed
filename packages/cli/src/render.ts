/**
 * Pure CLI helpers: argument parsing, period resolution, and report formatting.
 * No I/O — only type-level imports from core, so this module (and its tests)
 * have no runtime dependency on the built core package.
 */

import type { LeaderboardRow, LedgerSummary, OutcomeStats, TokenGroup, TokenStats } from '@tokenmaxed/core';

export type GroupBy = 'model' | 'lane';
export type LeaderboardSortBy = 'performance' | 'tokens' | 'difficulty';

export interface CliArgs {
  command: 'savings' | 'tokens' | 'outcomes' | 'lanes' | 'leaderboard' | 'dashboard' | 'help';
  /** 'all' or a relative window like '7d' / '24h'. */
  period: string;
  by: GroupBy;
  /** Sort axis for the `leaderboard` command. */
  leaderboardBy: LeaderboardSortBy;
  /** Emit JSON instead of a text table (leaderboard only). */
  json: boolean;
  /** Optional explicit ledger path (else the core default is used). */
  ledgerPath?: string;
  /** Lane config path for the `lanes` command (default config/lanes.yaml). */
  lanesPath?: string;
  /** Output file path for the `dashboard` command (default ~/.tokenmaxed/dashboard.html). */
  outPath?: string;
  /** dashboard: open the generated file with the platform opener. */
  open: boolean;
  /** leaderboard: emit the standalone static HTML page instead of text. */
  html: boolean;
}

/** A flattened view of a lane's trust config, for the `lanes` command. */
export interface LaneView {
  id: string;
  kind: string;
  model: string;
  trust_mode: string;
  roles: string[];
  managerEligible: boolean;
  executionMode: string;
}

/** Raised for invalid CLI arguments (callers print the message and exit non-zero). */
export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgError';
  }
}

function takeValue(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new CliArgError(`Missing value for ${flag}.`);
  }
  return value;
}

/** Parse argv (already sliced past `node script`). */
export function parseArgs(argv: readonly string[]): CliArgs {
  const COMMANDS = ['savings', 'tokens', 'outcomes', 'lanes', 'leaderboard', 'dashboard', 'help'] as const;
  let command: CliArgs['command'] | undefined;
  let period = 'all';
  let by: GroupBy = 'model';
  let leaderboardBy: LeaderboardSortBy = 'performance';
  let json = false;
  let byRaw: string | undefined;
  let ledgerPath: string | undefined;
  let lanesPath: string | undefined;
  let outPath: string | undefined;
  let open = false;
  let html = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        return { command: 'help', period, by, leaderboardBy, json, open, html };
      case '--period':
        period = takeValue(argv, i, '--period');
        i++;
        break;
      case '--by':
        byRaw = takeValue(argv, i, '--by');
        i++;
        break;
      case '--json':
        json = true;
        break;
      case '--ledger':
        ledgerPath = takeValue(argv, i, '--ledger');
        i++;
        break;
      case '--lanes':
        lanesPath = takeValue(argv, i, '--lanes');
        i++;
        break;
      case '--out':
        outPath = takeValue(argv, i, '--out');
        i++;
        break;
      case '--open':
        open = true;
        break;
      case '--html':
        html = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new CliArgError(`Unknown option "${arg}".`);
        }
        if (command !== undefined) {
          throw new CliArgError(`Unexpected argument "${arg}".`);
        }
        if (!(COMMANDS as readonly string[]).includes(arg)) {
          throw new CliArgError(`Unknown command "${arg}". Try one of: ${COMMANDS.join(', ')}.`);
        }
        command = arg as CliArgs['command'];
    }
  }

  const resolved = command ?? 'help';
  // Output flags stay scoped (an unknown flag elsewhere must not become
  // silently ignored): dashboard always; leaderboard only with --html.
  if (html && resolved !== 'leaderboard') {
    throw new CliArgError(`--html is only valid for "leaderboard" (got command "${resolved}").`);
  }
  const emitsFile = resolved === 'dashboard' || (resolved === 'leaderboard' && html);
  if ((open || outPath !== undefined) && !emitsFile) {
    throw new CliArgError(`--open/--out are only valid for "dashboard" or "leaderboard --html" (got command "${resolved}").`);
  }
  if (byRaw !== undefined) {
    if (resolved === 'leaderboard') {
      if (byRaw !== 'performance' && byRaw !== 'tokens' && byRaw !== 'difficulty') {
        throw new CliArgError(`--by must be "performance", "tokens", or "difficulty" (got "${byRaw}").`);
      }
      leaderboardBy = byRaw;
    } else if (resolved === 'tokens') {
      if (byRaw !== 'model' && byRaw !== 'lane') {
        throw new CliArgError(`--by must be "model" or "lane" (got "${byRaw}").`);
      }
      by = byRaw;
    } else if (byRaw !== 'model' && byRaw !== 'lane') {
      throw new CliArgError(`--by is only valid for "tokens" or "leaderboard" (got "${byRaw}").`);
    }
  }

  return {
    command: resolved,
    period,
    by,
    leaderboardBy,
    json,
    open,
    html,
    ...(ledgerPath ? { ledgerPath } : {}),
    ...(lanesPath ? { lanesPath } : {}),
    ...(outPath ? { outPath } : {}),
  };
}

/** Resolve a period string to an ISO cutoff (or undefined for "all"), given now in ms. */
export function resolvePeriodSince(period: string, nowMs: number): string | undefined {
  if (period === 'all') return undefined;
  const m = /^(\d+)([dh])$/.exec(period);
  if (!m) {
    throw new CliArgError(`Invalid --period "${period}". Use "all" or N followed by d/h, e.g. "7d".`);
  }
  const n = Number(m[1]);
  const ms = m[2] === 'd' ? n * 86_400_000 : n * 3_600_000;
  return new Date(nowMs - ms).toISOString();
}

/** Human label for a period string. */
export function periodLabel(period: string): string {
  return period === 'all' ? 'all time' : `last ${period}`;
}

const money = (n: number): string => `$${n.toFixed(2)}`;
const pct = (n: number): string => `${n.toFixed(1)}%`;
const int = (n: number): string => n.toLocaleString('en-US');

/** Whether a group's tokens were estimated, reported, or a mix. */
function estTag(g: TokenGroup): string {
  const hasEst = g.estimated.total > 0;
  const hasRep = g.reported.total > 0;
  if (hasEst && hasRep) return 'mixed';
  if (hasEst) return 'estimated';
  return 'reported';
}

function sortedGroups(groups: Record<string, TokenGroup>): [string, TokenGroup][] {
  return Object.entries(groups).sort((a, b) => {
    if (b[1].total !== a[1].total) return b[1].total - a[1].total;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
}

/**
 * The savings report: the honest finance-grade headline (actual API spend +
 * metered avoided), then the all-frontier baseline as a clearly-labeled
 * hypothetical, lane mix, block count, and a compact top-N token block. The
 * token block is explicitly labeled a usage count, never dollars.
 */
export function formatSavings(args: {
  summary: LedgerSummary;
  tokens: TokenStats;
  periodLabel: string;
  topN?: number;
}): string {
  const { summary, tokens, periodLabel: label, topN = 3 } = args;
  const lines: string[] = [`TokenMaxed — savings (${label})`, ''];

  if (summary.events === 0) {
    lines.push('  No tasks recorded yet.');
    return lines.join('\n');
  }

  const s = summary.savings;
  // HEADLINE = the honest, finance-grade numbers: what you actually paid, and the
  // metered spend avoided. The all-frontier baseline is a hypothetical ceiling
  // (every task on the top model) — real arithmetic, unreal baseline — so it is
  // demoted to a clearly-labeled secondary line, not the headline.
  lines.push(
    `  Actual API spend ${money(summary.metered_spent_total)} — saved ${money(s.metered_avoided)} ` +
      `(${pct(s.metered_avoided_pct)} of the frontier-equivalent cost)`,
    `  Baseline context: ${money(s.frontier_avoided)} avoided vs an all-frontier baseline ` +
      `(${pct(s.frontier_avoided_pct)}) — a hypothetical ceiling, not cash you'd otherwise have paid`,
    '',
  );

  const laneMix = Object.entries(summary.laneMix)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id, n]) => `${id} ×${n}`)
    .join(', ');
  lines.push(`  Lanes: ${laneMix}`, `  Sensitive sends blocked: ${summary.blockCount}`, '');

  const t = tokens.total;
  lines.push(`  Tokens (usage, not $): ${int(t.in)} in / ${int(t.out)} out / ${int(t.total)} total`);
  const top = sortedGroups(tokens.byModel).slice(0, topN);
  for (const [model, g] of top) {
    const share = t.total === 0 ? 0 : (g.total / t.total) * 100;
    lines.push(
      `    ${model}  ${int(g.in)} / ${int(g.out)} / ${int(g.total)}  (${pct(share)})  ${estTag(g)}`,
    );
  }
  lines.push('  → full breakdown: tokenmaxed tokens');
  return lines.join('\n');
}

/** A simple right-aligned-number table, deterministic ordering. */
export function formatTokens(args: { tokens: TokenStats; by: GroupBy; periodLabel: string }): string {
  const { tokens, by, periodLabel: label } = args;
  const groups = by === 'model' ? tokens.byModel : tokens.byLane;

  const header = [by, 'in', 'out', 'total', 'est/rep'];
  const rows: string[][] = sortedGroups(groups).map(([name, g]) => [
    name,
    int(g.in),
    int(g.out),
    int(g.total),
    estTag(g),
  ]);
  const totalRow = ['total', int(tokens.total.in), int(tokens.total.out), int(tokens.total.total), ''];

  const all = [header, ...rows, totalRow];
  const widths = header.map((_, col) => Math.max(...all.map((r) => r[col]!.length)));
  const fmtRow = (r: string[]): string =>
    '  ' +
    r
      .map((cell, col) => (col === 0 || col === r.length - 1 ? cell.padEnd(widths[col]!) : cell.padStart(widths[col]!)))
      .join('  ')
      .trimEnd();

  const sep = '  ' + widths.map((w) => '-'.repeat(w)).join('  ');
  const lines = [`TokenMaxed — tokens (${label}, by ${by})`, ''];
  if (rows.length === 0) {
    lines.push('  No tasks recorded yet.');
    return lines.join('\n');
  }
  lines.push(fmtRow(header), sep, ...rows.map(fmtRow), sep, fmtRow(totalRow));
  return lines.join('\n');
}

/** Render an aligned, left-justified table (rows[0] is the header). */
function table(rows: string[][]): string[] {
  const cols = rows[0]?.length ?? 0;
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  return rows.map((r) => '  ' + r.map((cell, c) => (cell ?? '').padEnd(widths[c]!)).join('  ').trimEnd());
}

/** The review-outcome report: pass/needs-rework/fail tallies + success rate per lane. */
export function formatOutcomes(args: { outcomes: OutcomeStats; periodLabel: string }): string {
  const { outcomes, periodLabel: label } = args;
  const lines = [`TokenMaxed — outcomes (${label})`, ''];
  if (outcomes.total.total === 0) {
    lines.push('  No reviews recorded yet.');
    return lines.join('\n');
  }
  const rows: string[][] = [['lane', 'pass', 'rework', 'fail', 'total', 'success']];
  const entries = Object.entries(outcomes.byLane).sort((a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1));
  for (const [laneId, g] of entries) {
    rows.push([laneId, `${g.pass}`, `${g.needs_rework}`, `${g.fail}`, `${g.total}`, pct(g.success_rate * 100)]);
  }
  const t = outcomes.total;
  rows.push(['total', `${t.pass}`, `${t.needs_rework}`, `${t.fail}`, `${t.total}`, pct(t.success_rate * 100)]);
  lines.push(...table(rows));
  lines.push('', '  (success = (pass + ½·needs-rework) / total; reviewer + user votes)');
  return lines.join('\n');
}

const pctRate = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** Real-usage leaderboard table (or JSON rows when json=true). */
export function formatLeaderboard(args: {
  rows: readonly LeaderboardRow[];
  periodLabel: string;
  sortBy: LeaderboardSortBy;
  json?: boolean;
}): string {
  const { rows, periodLabel: label, sortBy, json = false } = args;
  if (json) return JSON.stringify(rows) + '\n';

  const lines = [`TokenMaxed — leaderboard (${label}, by ${sortBy})`, ''];
  if (rows.length === 0) {
    lines.push('  No attributable reviews recorded yet.');
    return lines.join('\n');
  }

  const tableRows: string[][] = [
    ['model', 'category', 'difficulty', 'N', 'pass%', 'pass/rew/fail', 'tok-in', 'tok-out'],
  ];
  for (const r of rows) {
    tableRows.push([
      r.model,
      r.category,
      r.difficulty,
      `${r.users}`,
      pctRate(r.passRate),
      `${r.pass}/${r.needs_rework}/${r.fail}`,
      int(r.tokens_in),
      int(r.tokens_out),
    ]);
  }
  lines.push(...table(tableRows));
  lines.push(
    '',
    '  Measures who passes real reviews at difficulty D — not ground-truth capability. N = contributing users.',
  );
  return lines.join('\n');
}

/** The lanes report: each configured lane's trust mode, autonomy, roles, and manager eligibility. */
export function formatLanes(views: readonly LaneView[]): string {
  const lines = ['TokenMaxed — lanes', ''];
  if (views.length === 0) {
    lines.push('  No lanes configured.');
    return lines.join('\n');
  }
  const rows: string[][] = [['id', 'kind', 'model', 'trust_mode', 'exec', 'roles', 'manager']];
  for (const v of views) {
    rows.push([
      v.id,
      v.kind,
      v.model,
      v.trust_mode,
      v.executionMode,
      v.roles.length ? v.roles.join(',') : '-',
      v.managerEligible ? 'eligible' : 'no',
    ]);
  }
  lines.push(...table(rows));
  return lines.join('\n');
}
