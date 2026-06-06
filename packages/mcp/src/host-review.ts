/**
 * A-7 — host-turn manager review wiring. Shared by the router_review tool
 * (server) and the opt-in Stop gate (hook). Gets the turn's working-tree diff,
 * resolves a configured manager-eligible lane, runs it over the diff (pure
 * helpers from reviewer.ts), and records a content-free outcome via core
 * `review()`. The diff is sent only to a TRUSTED manager and is NEVER recorded.
 *
 * Imports core at runtime — only ever loaded inside the esbuild bundle (server /
 * hook), never by `node --test` (no test imports this; the pure logic it relies
 * on lives in reviewer.ts and is tested there).
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseModelAlias, resolveLaneModel, review } from '@tokenmaxed/core';
import type { Lane, OutcomeEventInput, Policy, ReviewVerdict } from '@tokenmaxed/core';
import {
  JsonlLedger,
  loadLaneConfig,
  loadPriceTable,
  makeCliExecutor,
  makeTrustedApiExecutor,
  makeTrustedExecutor,
} from '@tokenmaxed/core/node';

import { makeAvailabilityProbe } from './availability.ts';
import { homeFile, makeCliSpawn, makeLoadPolicy, makeResolveAuth } from './config.ts';
import { selectManagerLane } from './manager-select.ts';
import { buildReviewPrompt, parseManagerVerdict } from './reviewer.ts';

/** Outcome of a host-turn review. */
export interface HostReviewResult {
  reviewed: boolean;
  verdict?: ReviewVerdict;
  notes?: string;
  managerLaneId?: string;
  /** Why no review ran (no changes, no manager, …). */
  reason?: string;
}

/** Injected I/O for {@link runHostTurnReview} (real impls from makeHostReviewDeps). */
export interface HostReviewDeps {
  /** The turn's working-tree diff (empty ⇒ nothing to review). */
  readDiff: () => string;
  /** Configured lanes, or null when no config file exists yet. */
  loadLanes: () => Lane[] | null;
  /** Ids of lanes that can actually run now, so an unavailable manager isn't picked. */
  availableLaneIds: (lanes: readonly Lane[]) => Promise<string[]>;
  /** The active policy (fail-closed loader); gates which manager lanes are allowed. */
  loadPolicy: () => Policy;
  /** Run the manager lane over a prompt, returning its raw text. */
  runManager: (lane: Lane, prompt: string) => Promise<string>;
  /** Persist the content-free outcome event (best-effort). */
  appendOutcome: (event: OutcomeEventInput) => void;
  /** The safety-gate posture — gates API managers (egress) just like routing. */
  gateReady: boolean;
  newId: () => string;
}

/** Review the turn's diff with a configured manager. Pure over its injected deps. */
export async function runHostTurnReview(turnId: string, deps: HostReviewDeps): Promise<HostReviewResult> {
  const diff = deps.readDiff();
  if (!diff.trim()) return { reviewed: false, reason: 'no working-tree changes to review' };

  const lanes = deps.loadLanes();
  if (!lanes) return { reviewed: false, reason: 'no lanes configured yet — run /tokenmaxed:setup' };

  // Skip a manager that can't run now (e.g. Codex not installed) so review falls
  // through to an available manager instead of failing to spawn.
  const available = new Set(await deps.availableLaneIds(lanes));
  const manager = selectManagerLane(lanes, deps.loadPolicy(), deps.gateReady, available);
  if (!manager) {
    return {
      reviewed: false,
      reason:
        'no usable manager lane configured (needs manager_allowed on a trusted CLI/local lane, not policy-blocked; an API manager needs the safety gate open)',
    };
  }

  const result = await review(
    { turn_id: turnId, category: 'refactor', content: diff },
    {
      managerLane: manager,
      runManagerReview: async (lane, content) => parseManagerVerdict(await deps.runManager(lane, buildReviewPrompt(content))),
      newId: deps.newId,
    },
  );
  try {
    deps.appendOutcome(result.event);
  } catch {
    /* recording is best-effort; never fail a review over the ledger */
  }
  const out: HostReviewResult = { reviewed: true, verdict: result.verdict, managerLaneId: manager.id };
  if (result.notes) out.notes = result.notes;
  return out;
}

/**
 * Build a runner function compatible with {@link runReviewWithBudget} from a set
 * of real host-review deps. The runner passes the supplied `turnId` directly to
 * {@link runHostTurnReview} so the budget helper can share one ID across retries.
 */
export function makeReviewRunner(
  deps: HostReviewDeps,
): (turnId: string) => Promise<HostReviewResult> {
  return (turnId) => runHostTurnReview(turnId, deps);
}

const MAX_DIFF_BYTES = 256 * 1024; // truncate what we hand the manager
const GIT_MAX_BUFFER = 64 * 1024 * 1024; // read big diffs without ENOBUFS, then truncate
const GIT_TIMEOUT_MS = 15_000; // git diff is fast; bound it so a wedged git can't hang us
const REVIEW_CLI_TIMEOUT_MS = 90_000; // a manager review of a diff should be quick

/** Build the real host-review deps from the environment (git + executor + ledger). */
export function makeHostReviewDeps(env: NodeJS.ProcessEnv): HostReviewDeps {
  // CLAUDE_PROJECT_DIR is a real path; TOKENMAXED_PROJECT is only the toggle KEY
  // (may be a logical id), so it must NOT be used as git's cwd.
  const cwd = env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const lanesPath = env.TOKENMAXED_LANES ?? homeFile('lanes.yaml');
  const ledgerPath = env.TOKENMAXED_LEDGER; // undefined ⇒ JsonlLedger default
  // Same package-relative seed the server/summary use, so the review path resolves
  // `<family>@latest` against the SAME price table everything else does.
  const pricesPath = env.TOKENMAXED_PRICES ?? fileURLToPath(new URL('../prices.seed.json', import.meta.url));
  const resolveAuth = makeResolveAuth(env);
  const executor = makeTrustedExecutor({
    cli: makeCliExecutor(makeCliSpawn(REVIEW_CLI_TIMEOUT_MS)),
    api: makeTrustedApiExecutor({ resolveAuth }),
  });

  return {
    readDiff: () => {
      // All tracked changes vs HEAD (staged + unstaged). Untracked files are not
      // included — a known v0 limitation (documented). Read with a large buffer so
      // a big diff doesn't ENOBUFS (which would look like "no changes"), then
      // truncate explicitly for the manager.
      const res = spawnSync('git', ['diff', 'HEAD'], { cwd, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS });
      if (res.status !== 0 || typeof res.stdout !== 'string') return '';
      const diff = res.stdout;
      return diff.length > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}\n\n[diff truncated for review]` : diff;
    },
    loadLanes: () => {
      if (!existsSync(lanesPath)) return null;
      const raw = [...loadLaneConfig(lanesPath).lanes];
      // Resolve `<family>@latest` to a concrete priced id BEFORE manager selection /
      // execution — otherwise a manager on an alias (e.g. claude-haiku@latest) would
      // spawn `claude --model claude-haiku@latest` (invalid) or send the alias in an
      // API body. Mirrors server.ts's routing path. Drop any STILL-unresolved alias
      // (no priced family member) so it can never be selected and fail to spawn.
      let table;
      try {
        table = loadPriceTable(pricesPath);
      } catch {
        return raw; // no price table ⇒ best-effort (concrete pins still work)
      }
      return raw.map((l) => resolveLaneModel(l, table)).filter((l) => !parseModelAlias(l.model).latest);
    },
    availableLaneIds: makeAvailabilityProbe(env),
    loadPolicy: makeLoadPolicy(env),
    runManager: async (lane, prompt) => (await executor(lane, prompt)).resultText,
    appendOutcome: (event) => {
      new JsonlLedger(ledgerPath).appendOutcome(event);
    },
    gateReady: env.TOKENMAXED_GATE_READY === 'true',
    newId: () => randomUUID(),
  };
}
