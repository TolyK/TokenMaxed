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

import { evaluate, isManagerEligible, isSelectablePreGate, laneAllowedByVerdict, review } from '@tokenmaxed/core';
import type { Lane, OutcomeEventInput, Policy, ReviewVerdict } from '@tokenmaxed/core';
import {
  JsonlLedger,
  loadLaneConfig,
  makeCliExecutor,
  makeTrustedApiExecutor,
  makeTrustedExecutor,
} from '@tokenmaxed/core/node';

import { homeFile, makeCliSpawn, makeLoadPolicy, makeResolveAuth } from './config.ts';
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

  // Need an EXECUTABLE manager (native/host can't be run from here) that is also
  // gate-selectable AND policy-allowed — so the diff is never sent to a lane the
  // user disabled/blocked, and an API manager only receives it once the gate is
  // open (egress protection), exactly like the router gate.
  const policy = deps.loadPolicy();
  const disabled = new Set(policy.disabledLaneIds ?? []);
  // The diff IS the user's real working code, so evaluate manager egress as the
  // most sensitive context (private + sensitive). A policy that blocks, say, a
  // non-Anthropic API manager for sensitive content then correctly applies — we
  // never send the diff to a lane the user's policy meant to exclude.
  const reviewContext = { repo_class: 'private' as const, sensitivity: 'sensitive' as const };
  const manager = lanes.find(
    (l) =>
      isManagerEligible(l) &&
      !l.native &&
      isSelectablePreGate(l, deps.gateReady) &&
      !disabled.has(l.id) &&
      laneAllowedByVerdict(l, evaluate({ category: 'refactor' }, l, reviewContext, policy).verdict),
  );
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
    loadLanes: () => (existsSync(lanesPath) ? [...loadLaneConfig(lanesPath).lanes] : null),
    loadPolicy: makeLoadPolicy(env),
    runManager: async (lane, prompt) => (await executor(lane, prompt)).resultText,
    appendOutcome: (event) => {
      new JsonlLedger(ledgerPath).appendOutcome(event);
    },
    gateReady: env.TOKENMAXED_GATE_READY === 'true',
    newId: () => randomUUID(),
  };
}
