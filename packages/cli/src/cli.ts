#!/usr/bin/env node
/**
 * TokenMaxed CLI entry point. Thin glue: parse args, load the local ledger,
 * filter by period, and print a pure-formatted report. All formatting and
 * parsing logic lives in (and is tested via) ./render.ts.
 */

import { filterEventsSince, summarize, tokenStats } from '@tokenmaxed/core';
import { JsonlLedger } from '@tokenmaxed/core/node';

import {
  CliArgError,
  formatSavings,
  formatTokens,
  parseArgs,
  periodLabel,
  resolvePeriodSince,
} from './render.ts';

const HELP = `TokenMaxed — route coding tasks to the cheapest capable lane.

Usage:
  tokenmaxed savings [--period <p>] [--ledger <path>]
  tokenmaxed tokens  [--period <p>] [--by model|lane] [--ledger <path>]
  tokenmaxed help

Options:
  --period <p>   all (default) or a window like 7d / 24h
  --by <g>       group tokens by "model" (default) or "lane"
  --ledger <p>   ledger file path (default: ~/.tokenmaxed/ledger.jsonl)
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
    const ledger = new JsonlLedger(args.ledgerPath);
    const since = resolvePeriodSince(args.period, Date.now());
    const events = filterEventsSince(ledger.readAll(), since);
    const label = periodLabel(args.period);

    if (args.command === 'savings') {
      process.stdout.write(
        formatSavings({ summary: summarize(events), tokens: tokenStats(events), periodLabel: label }) + '\n',
      );
    } else {
      process.stdout.write(
        formatTokens({ tokens: tokenStats(events), by: args.by, periodLabel: label }) + '\n',
      );
    }
  } catch (err) {
    if (err instanceof CliArgError) fail(err.message, 2);
    fail(err instanceof Error ? err.message : String(err));
  }
}

main();
