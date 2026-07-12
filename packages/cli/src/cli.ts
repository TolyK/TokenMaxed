#!/usr/bin/env node
/**
 * TokenMaxed CLI entry point. Thin glue: parse args, load the local ledger /
 * lane config, and print a pure-formatted report. All formatting and parsing
 * logic lives in (and is tested via) ./render.ts.
 */

// F: first-party host identity — the tokenmaxed CLI declares itself so any
// hosts:-restricted lane listing `cli` stays selectable if routing is ever
// invoked from here (an explicit TOKENMAXED_HOST still wins).
process.env.TOKENMAXED_HOST ??= 'cli';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { loadPriceTable } from '@tokenmaxed/core/node';
import {
  buildSharePayload,
  formatSharePreview,
  isoWeekStartMs,
  readOrCreateContributor,
  recordRevision,
  rotateContributor,
  uploadSnapshot,
} from './share.ts';
import type { ContributorStore } from './share.ts';
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
  tokenmaxed share [--yes] [--rotate-id] [--ledger <path>]
                 OPT-IN: show this ISO week's anonymized aggregate payload
                 (default sends NOTHING); --yes uploads exactly that payload
                 to TOKENMAXED_SHARE_URL (unset until the hosted leaderboard
                 launches); --rotate-id mints a fresh contributor UUID
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
  --out <p>      dashboard / leaderboard --html: output HTML path
                 (defaults: ~/.tokenmaxed/dashboard.html / leaderboard.html)
  --open         dashboard / leaderboard --html: open the generated file
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

    if (args.command === 'share') {
      const contributorPath = process.env.TOKENMAXED_CONTRIBUTOR ?? join(homedir(), '.tokenmaxed', 'contributor.json');
      const store: ContributorStore = {
        read: () => (existsSync(contributorPath) ? readFileSync(contributorPath, 'utf8') : undefined),
        write: (text) => {
          mkdirSync(dirname(contributorPath), { recursive: true });
          writeFileSync(contributorPath, text, 'utf8');
        },
      };
      if (args.rotateId) {
        const rotated = rotateContributor(store, () => randomUUID(), () => new Date().toISOString());
        process.stdout.write(`new contributor id: ${rotated.contributor_id}\n(past uploads stay under the old id; future uploads use this one)\n`);
        return;
      }
      const now = Date.now();
      const state = readOrCreateContributor(store, () => randomUUID(), () => new Date().toISOString());
      // THIS ISO week's events only — the payload's window claim must be true.
      const weekEvents = filterEventsSince(new JsonlLedger(args.ledgerPath).readAll(), new Date(isoWeekStartMs(now)).toISOString());
      const rows = sortLeaderboard(buildLeaderboard(weekEvents), 'performance');
      if (rows.length === 0) {
        process.stdout.write('nothing to share yet — no routed work with review verdicts this ISO week.\n');
        return;
      }
      // The trusted model catalog: the price table's ids ∪ configured lane
      // models (the SAME membership rule the server enforces) — a real check
      // that REFUSES unknown models client-side. Only when NO price table is
      // loadable does the client skip its check (catalog = own rows) and SAY
      // so; the server still enforces its own catalog either way.
      const catalog = new Set<string>();
      let catalogChecked = false;
      try {
        for (const id of Object.keys(loadPriceTable(join(homedir(), '.tokenmaxed', 'prices.seed.json')).models)) catalog.add(id);
        catalogChecked = true;
      } catch {
        /* no local price table */
      }
      const userLanesPath = join(homedir(), '.tokenmaxed', 'lanes.yaml');
      if (existsSync(userLanesPath)) {
        try {
          for (const lane of loadLaneConfig(userLanesPath).lanes) catalog.add(lane.model);
        } catch {
          /* unreadable lanes ⇒ price-table-only catalog */
        }
      }
      if (!catalogChecked) for (const r of rows) catalog.add(r.model);
      const payload = buildSharePayload(rows, state, now, catalog);
      const endpoint = process.env.TOKENMAXED_SHARE_URL?.trim() || undefined;
      const catalogNote = catalogChecked
        ? undefined
        : 'note: no local price table found, so the client-side model-catalog check was skipped — the server still enforces its own catalog.';
      if (!args.yes) {
        process.stdout.write(formatSharePreview(payload, { endpoint, ...(catalogNote ? { catalogNote } : {}) }) + '\n');
        return;
      }
      if (!endpoint) {
        fail('no share endpoint configured — the hosted leaderboard has not launched yet (TOKENMAXED_SHARE_URL will be announced at launch).');
      }
      void (async () => {
        const result = await uploadSnapshot(fetch as unknown as Parameters<typeof uploadSnapshot>[0], endpoint, payload.serialized);
        if (result.ok) {
          recordRevision(store, state, payload.windowId, payload.revision);
          process.stdout.write(`uploaded ${payload.windowId} revision ${payload.revision} (${payload.snapshot.rows.length} cells). Thank you — contributors keep the data feed free.\n`);
        } else {
          fail(result.message);
        }
      })();
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
