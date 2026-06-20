#!/usr/bin/env node
/**
 * TokenMaxed CLI entry point. Thin glue: parse args, load the local ledger /
 * lane config, and print a pure-formatted report. All formatting and parsing
 * logic lives in (and is tested via) ./render.ts.
 */

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
  tokenmaxed leaderboard [--period <p>] [--by performance|tokens|difficulty] [--json] [--ledger <path>]
  tokenmaxed lanes       [--lanes <path>]
  tokenmaxed help

Options:
  --period <p>   all (default) or a window like 7d / 24h
  --by <g>       tokens: group by "model" (default) or "lane"
                 leaderboard: sort by "performance" (default), "tokens", or "difficulty"
  --json         leaderboard: emit rows as JSON (for external chart rendering)
  --ledger <p>   ledger file path (default: ~/.tokenmaxed/ledger.jsonl)
  --lanes <p>    lane config path for "lanes" (default: config/lanes.yaml)
  -h, --help     show this help`;

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
