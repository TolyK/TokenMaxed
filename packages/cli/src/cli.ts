#!/usr/bin/env node
/**
 * TokenMaxed CLI entry point. Thin glue: parse args, load the local ledger /
 * lane config, and print a pure-formatted report. All formatting and parsing
 * logic lives in (and is tested via) ./render.ts.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  buildLeaderboard,
  executionModeOf,
  filterEventsSince,
  isManagerEligible,
  outcomeStats,
  sortLeaderboard,
  summarize,
  tokenStats,
} from '@tokenmaxed/core';
import { JsonlLedger, loadLaneConfig } from '@tokenmaxed/core/node';

import { mergeShareSnapshots, shareSnapshotFromRows } from '@tokenmaxed/core';
import { buildDashboardData, renderDashboardHtml } from './dashboard.ts';
import { renderLeaderboardPage } from './leaderboard-page.ts';

/** Best-effort platform opener — never crashes the CLI after the write. */
function openFile(path: string): void {
  const child =
    process.platform === 'win32'
      ? spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [path], { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    /* best-effort — the path was already printed */
  });
  child.unref();
}

import {
  CliArgError,
  formatLanes,
  formatLeaderboard,
  formatOutcomes,
  formatSavings,
  formatTokens,
  parseArgs,
  periodLabel,
  resolvePeriodSince,
} from './render.ts';
import type { LaneView } from './render.ts';

const HELP = `TokenMaxed — route coding tasks to the cheapest capable lane.

Usage:
  tokenmaxed savings  [--period <p>] [--ledger <path>]
  tokenmaxed tokens   [--period <p>] [--by model|lane] [--ledger <path>]
  tokenmaxed outcomes    [--period <p>] [--ledger <path>]
  tokenmaxed leaderboard [--period <p>] [--by performance|tokens|difficulty] [--json] [--html [--out <path>] [--open]] [--ledger <path>]
  tokenmaxed lanes       [--lanes <path>]
  tokenmaxed dashboard   [--out <path>] [--open] [--ledger <path>] [--lanes <path>]
  tokenmaxed help

Options:
  --period <p>   all (default) or a window like 7d / 24h
  --by <g>       tokens: group by "model" (default) or "lane"
                 leaderboard: sort by "performance" (default), "tokens", or "difficulty"
  --json         leaderboard: emit rows as JSON (for external chart rendering)
  --ledger <p>   ledger file path (default: ~/.tokenmaxed/ledger.jsonl)
  --lanes <p>    lane config path for "lanes"/"dashboard" (default: config/lanes.yaml;
                 dashboard prefers ~/.tokenmaxed/lanes.yaml when it exists)
  --out <p>      dashboard: output HTML path (default: ~/.tokenmaxed/dashboard.html)
  --open         dashboard: open the generated file
  -h, --help     show this help

The dashboard is fully local-first: one self-contained HTML file generated from
your content-free ledger — no server, no network requests.`;

function fail(message: string, code = 1): never {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function main(): void {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliArgError) fail(err.message + '\n\n' + HELP, 2);
    throw err;
  }

  if (args.command === 'help') {
    process.stdout.write(HELP + '\n');
    return;
  }

  try {
    if (args.command === 'lanes') {
      const registry = loadLaneConfig(args.lanesPath ?? 'config/lanes.yaml');
      const views: LaneView[] = registry.lanes.map((lane) => ({
        id: lane.id,
        kind: lane.kind,
        model: lane.model,
        trust_mode: lane.trust_mode,
        roles: lane.roles ? [...lane.roles] : [],
        managerEligible: isManagerEligible(lane),
        executionMode: executionModeOf(lane),
      }));
      process.stdout.write(formatLanes(views) + '\n');
      return;
    }

    if (args.command === 'dashboard') {
      const events = new JsonlLedger(args.ledgerPath).readAll();
      // The dashboard is about the USER's live setup, so it prefers the
      // user-owned lanes.yaml over the repo config when neither is explicit.
      const userLanes = join(homedir(), '.tokenmaxed', 'lanes.yaml');
      const lanesPath = args.lanesPath ?? (existsSync(userLanes) ? userLanes : 'config/lanes.yaml');
      const lanes = existsSync(lanesPath) ? loadLaneConfig(lanesPath).lanes : [];
      const html = renderDashboardHtml(buildDashboardData(events, lanes, Date.now()));
      const outPath = resolve(args.outPath ?? join(homedir(), '.tokenmaxed', 'dashboard.html'));
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, html, 'utf8');
      process.stdout.write(`dashboard written: ${outPath}\n(local-first — one self-contained file, no network; regenerate any time)\n`);
      if (args.open) openFile(outPath);
      return;
    }

    const ledger = new JsonlLedger(args.ledgerPath);
    const since = resolvePeriodSince(args.period, Date.now());
    const events = filterEventsSince(ledger.readAll(), since);
    const label = periodLabel(args.period);

    if (args.command === 'savings') {
      process.stdout.write(
        formatSavings({ summary: summarize(events), tokens: tokenStats(events), periodLabel: label }) + '\n',
      );
    } else if (args.command === 'tokens') {
      process.stdout.write(formatTokens({ tokens: tokenStats(events), by: args.by, periodLabel: label }) + '\n');
    } else if (args.command === 'leaderboard') {
      const rows = sortLeaderboard(buildLeaderboard(events), args.leaderboardBy);
      if (args.html) {
        // D: the standalone local-mode page (N=1, unsuppressed, loudly labeled)
        // — the SAME static artifact the published Vercel page will be, fed a
        // densified aggregate instead. users=1 via a single local snapshot.
        const cells = mergeShareSnapshots(
          [shareSnapshotFromRows(rows, { contributor_id: 'local', window_id: 'local', revision: 1 })],
          { localOnly: true }, // on-machine view; the wire path requires a catalog
        );
        const html = renderLeaderboardPage(cells, { mode: 'local', generatedAtIso: new Date().toISOString() });
        const outPath = resolve(args.outPath ?? join(homedir(), '.tokenmaxed', 'leaderboard.html'));
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, html, 'utf8');
        process.stdout.write(`leaderboard page written: ${outPath}\n(local view — nothing uploaded)\n`);
        if (args.open) openFile(outPath);
        return;
      }
      process.stdout.write(
        formatLeaderboard({ rows, periodLabel: label, sortBy: args.leaderboardBy, json: args.json }),
      );
    } else {
      // outcomes
      process.stdout.write(formatOutcomes({ outcomes: outcomeStats(events), periodLabel: label }) + '\n');
    }
  } catch (err) {
    if (err instanceof CliArgError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

main();
