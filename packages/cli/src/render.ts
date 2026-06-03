/**
 * Pure CLI helpers: argument parsing, period resolution, and report formatting.
 * No I/O — only type-level imports from core, so this module (and its tests)
 * have no runtime dependency on the built core package.
 */

import type { LedgerSummary, OutcomeStats, TokenGroup, TokenStats } from '@tokenmaxed/core';

export type GroupBy = 'model' | 'lane';

export interface CliArgs {
  command: 'savings' | 'tokens' | 'outcomes' | 'lanes' | 'help';
  /** 'all' or a relative window like '7d' / '24h'. */
  period: string;
  by: GroupBy;
  /** Optional explicit ledger path (else the core default is used). */
  ledgerPath?: string;
  /** Lane config path for the `lanes` command (default config/lanes.yaml). */
  lanesPath?: string;
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
  const COMMANDS = ['savings', 'tokens', 'outcomes', 'lanes', 'help'] as const;
  let command: CliArgs['command'] | undefined;
  let period = 'all';
  let by: GroupBy = 'model';
  let ledgerPath: string | undefined;
  let lanesPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        return { command: 'help', period, by };
      case '--period':
        period = takeValue(argv, i, '--period');
        i++;
        break;
      case '--by': {
        const v = takeValue(argv, i, '--by');
        if (v !== 'model' && v !== 'lane') {
          throw new CliArgError(`--by must be "model" or "lane" (got "${v}").`);
        }
        by = v;
        i++;
        break;
      }
      case '--ledger':
        ledgerPath = takeValue(argv, i, '--ledger');
        i++;
        break;
      case '--lanes':
        lanesPath = takeValue(argv, i, '--lanes');
        i++;
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
  return {
    command: command ?? 'help',
    period,
    by,
    ...(ledgerPath ? { ledgerPath } : {}),
    ...(lanesPath ? { lanesPath } : {}),
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
 * The savings report: an estimated frontier-equivalent headline, the honest
 * metered numbers, lane mix, block count, and a compact top-N token block. The
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
  lines.push(
    `  Estimated ${money(s.frontier_avoided)} avoided vs the all-frontier baseline ` +
      `(${pct(s.frontier_avoided_pct)} of frontier cost)`,
    `  Metered API — spent ${money(summary.metered_spent_total)}, ` +
      `avoided ${money(s.metered_avoided)} (${pct(s.metered_avoided_pct)})`,
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
