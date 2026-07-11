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
import { hostFromEnv } from './host-id.ts';
import { buildReviewPrompt, parseManagerVerdict } from './reviewer.ts';

/** Outcome of a host-turn review. */
export interface HostReviewResult {
  reviewed: boolean;
  verdict?: ReviewVerdict;
  notes?: string;
  managerLaneId?: string;
  /** Why no review ran (no changes, no manager, …). */
  reason?: string;
  /**
   * REVIEW-LOOP: true ⇒ no review because of an ERROR/timeout (distinct from the
   * benign "no changes" / "no manager" skips). The Stop hook surfaces this so a
   * failed review is never mistaken for a silent pass (Protection A).
   */
  errored?: boolean;
}

/** The working-tree diff read for review, plus whether it was fully acquired. */
export interface DiffRead {
  /** The diff handed to the manager (carries an appended coverage NOTE if partial). */
  diff: string;
  /**
   * true ⇒ the diff could NOT be fully acquired — `git diff HEAD` failed, untracked
   * enumeration failed, or some untracked files were dropped for the size/time
   * budget. A non-empty diff is still reviewed (the NOTE warns the manager); an
   * EMPTY-but-incomplete read is surfaced as a review error, never a silent pass.
   */
  incomplete: boolean;
  /** Why the read failed (git's own stderr/error), so the surfaced retry is actionable. */
  incompleteReason?: string;
}

/** Injected I/O for {@link runHostTurnReview} (real impls from makeHostReviewDeps). */
export interface HostReviewDeps {
  /** The turn's working-tree diff (empty + complete ⇒ nothing to review). */
  readDiff: () => DiffRead;
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
  /** F: this adapter's host id — a hosts:-restricted manager needs it listed (fail closed). */
  host?: string;
  newId: () => string;
}

/** Review the turn's diff with a configured manager. Pure over its injected deps. */
export async function runHostTurnReview(turnId: string, deps: HostReviewDeps): Promise<HostReviewResult> {
  // Establish a usable REVIEWER first — BEFORE reading the diff. A diff-read error
  // (e.g. broken/absent git) is only worth surfacing/re-firing when a reviewer
  // actually exists; if none is configured, "nothing is reviewed" is the documented
  // opt-out, so we must not block such a session over a git failure.
  const lanes = deps.loadLanes();
  if (!lanes) return { reviewed: false, reason: 'no lanes configured yet — run /tokenmaxed:setup' };

  // Skip a manager that can't run now (e.g. Codex not installed) so review falls
  // through to an available manager instead of failing to spawn.
  const available = new Set(await deps.availableLaneIds(lanes));
  const manager = selectManagerLane(lanes, deps.loadPolicy(), deps.gateReady, available, deps.host);
  if (!manager) {
    return {
      reviewed: false,
      reason:
        'no usable manager lane configured (needs manager_allowed on a trusted CLI/local lane, not policy-blocked; an API manager needs the safety gate open)',
    };
  }

  // A reviewer exists — now read the diff.
  const { diff, incomplete, incompleteReason } = deps.readDiff();
  if (!diff.trim()) {
    // Empty AND incomplete ⇒ we couldn't acquire the diff (git failed). Surface it
    // as an ERROR (Protection A) — the Stop hook RE-FIRES on it — never a silent
    // "no changes" pass. Carry git's own reason so the retry message is actionable.
    if (incomplete) {
      const detail = incompleteReason ? `: ${incompleteReason}` : ' (git failed)';
      return { reviewed: false, errored: true, reason: `could not read the working-tree diff${detail}` };
    }
    return { reviewed: false, reason: 'no working-tree changes to review' };
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
const MAX_UNTRACKED_FILES = 50; // hard cap on how many new files we synthesize add-diffs for
const UNTRACKED_BUDGET_MS = 8_000; // total wall-clock cap for the whole untracked pass
const UNTRACKED_FILE_TIMEOUT_MS = 5_000; // per-file git timeout (was 15 s — too long × N)
const UNTRACKED_FILE_MAXBUF = 4 * 1024 * 1024; // per-file read bound (combined is truncated anyway)

/**
 * Total wall-clock budget for one host review — every call site passes this as
 * `totalBudgetMs` (single attempt). A reasoning-model review of a real diff takes
 * minutes; 90s was too short (ETIMEDOUT mislabeled as "failed to spawn").
 */
export const REVIEW_BUDGET_MS = 300_000;
/**
 * Headroom the budget reserves for the SYNCHRONOUS diff acquisition that runs BEFORE
 * the CLI spawn and which the budget's slot guard cannot preempt. The CLI's OWN OS
 * timeout is the budget MINUS this headroom, so diff-read + CLI stay within the
 * advertised budget even in the WORST case. Derived from the actual diff-read timeouts
 * (not a guess): tracked `git diff HEAD` + untracked `git ls-files` (each GIT_TIMEOUT_MS)
 * + the untracked per-file wall-clock budget + a final per-file diff started just under
 * that budget (UNTRACKED_FILE_TIMEOUT_MS overrun).
 */
const DIFF_ACQUISITION_HEADROOM_MS =
  GIT_TIMEOUT_MS + GIT_TIMEOUT_MS + UNTRACKED_BUDGET_MS + UNTRACKED_FILE_TIMEOUT_MS;
// The CLI lane's OS-level spawn timeout (spawnSync is synchronous — Promise.race can't
// preempt it, so this is the real backstop). Strictly LESS than REVIEW_BUDGET_MS by the
// full diff-acquisition headroom, so diff-read + CLI ≤ REVIEW_BUDGET_MS always.
const REVIEW_CLI_TIMEOUT_MS = REVIEW_BUDGET_MS - DIFF_ACQUISITION_HEADROOM_MS;

/**
 * REVIEW-LOOP — "review ALL changed code": synthesize add-style diffs for
 * UNTRACKED (new, not-yet-`git add`ed) files so the reviewer sees them too
 * (`git diff HEAD` alone misses them — the old v0 gap). NON-MUTATING (never
 * touches the index) and fails soft to empty on any error so the Stop hook
 * degrades to the tracked-only diff rather than erroring.
 *
 * HARD-BOUNDED so it can never wedge the default-on Stop hook: each `git diff` is
 * a synchronous `spawnSync` the review budget cannot preempt, so we stop the pass
 * as soon as we hit ANY of — the byte budget (we truncate to MAX_DIFF_BYTES
 * downstream anyway), the file cap, or the wall-clock budget.
 *
 * Coverage honesty: `omitted` counts every enumerated file NOT actually included
 * in the returned diff — files we never reached (a bound tripped) AND files we
 * attempted but got nothing usable from (a per-file diff failure/timeout). It is
 * computed from what made it IN, so a skipped file can't hide. `enumerationFailed`
 * flags the case where `git ls-files` itself failed (we don't even know the set).
 * The caller turns either signal into an explicit incomplete-coverage marker.
 */
function readUntrackedDiff(cwd: string): { diff: string; omitted: number; enumerationFailed: boolean } {
  const list = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
  });
  if (list.status !== 0 || typeof list.stdout !== 'string') return { diff: '', omitted: 0, enumerationFailed: true };
  const all = list.stdout.split('\0').filter(Boolean);
  const parts: string[] = [];
  let bytes = 0;
  let included = 0;
  const startedAt = Date.now();
  for (const f of all) {
    // Stop early on any bound — keeps Stop snappy and within the review budget.
    if (bytes >= MAX_DIFF_BYTES || included >= MAX_UNTRACKED_FILES || Date.now() - startedAt > UNTRACKED_BUDGET_MS) {
      break;
    }
    // `git diff --no-index -- /dev/null <f>` emits an add-style patch. It exits 1
    // when the inputs differ (always true vs the empty null device), so we take
    // stdout regardless of status (don't gate on status === 0). git treats
    // `/dev/null` specially even on Windows; if it can't, this file is skipped
    // (and counted as omitted below). A new file always yields a non-empty patch
    // header, so empty stdout means the per-file diff genuinely failed/timed out.
    const d = spawnSync('git', ['diff', '--no-index', '--', '/dev/null', f], {
      cwd,
      encoding: 'utf8',
      maxBuffer: UNTRACKED_FILE_MAXBUF,
      timeout: UNTRACKED_FILE_TIMEOUT_MS,
    });
    if (typeof d.stdout === 'string' && d.stdout) {
      parts.push(d.stdout);
      bytes += d.stdout.length;
      included += 1;
    }
  }
  // Everything enumerated but NOT included (bound-skipped or per-file failure).
  return { diff: parts.join('\n'), omitted: Math.max(0, all.length - included), enumerationFailed: false };
}

/** Build the real host-review deps from the environment (git + executor + ledger). */
export function makeHostReviewDeps(env: NodeJS.ProcessEnv): HostReviewDeps {
  // A REAL path is required for git's cwd: TOKENMAXED_PROJECT_DIR (host-neutral,
  // set by non-Claude adapters like the OpenCode plugin) wins, then Claude's
  // CLAUDE_PROJECT_DIR. TOKENMAXED_PROJECT is only the toggle KEY (may be a
  // logical id), so it must NOT be used here — a wrong cwd reviews the wrong repo.
  const cwd = env.TOKENMAXED_PROJECT_DIR ?? env.CLAUDE_PROJECT_DIR ?? process.cwd();
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
    readDiff: (): DiffRead => {
      // All tracked changes vs HEAD (staged + unstaged). Read with a large buffer
      // so a big diff doesn't ENOBUFS (which would look like "no changes"). A git
      // FAILURE here is tracked (trackedOk) so we don't pass it off as "no changes".
      const res = spawnSync('git', ['diff', 'HEAD'], { cwd, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS });
      const trackedOk = res.status === 0 && typeof res.stdout === 'string';
      const tracked = trackedOk ? (res.stdout as string) : '';
      // Capture WHY a failed read failed (git's first stderr line, or a spawn error)
      // so the surfaced retry/yield message is actionable, e.g. "not a git repository".
      const trackedFailReason = trackedOk
        ? undefined
        : (typeof res.stderr === 'string' && res.stderr.trim().split('\n')[0]) ||
          (res.error ? `git not runnable: ${res.error.message}` : 'git diff HEAD failed');
      // REVIEW-LOOP — "review ALL changed code" includes UNTRACKED/new files (the
      // old v0 gap). Hard-bounded + fails soft so it can't wedge or starve the
      // Stop hook; degrades to tracked-only on any error (and flags it incomplete).
      let untracked = { diff: '', omitted: 0, enumerationFailed: false };
      try {
        untracked = readUntrackedDiff(cwd);
      } catch {
        untracked = { diff: '', omitted: 0, enumerationFailed: true };
      }
      const body = [tracked, untracked.diff].filter((s) => s.trim()).join('\n');
      // Truncate the body FIRST, then append coverage markers so they always survive
      // (a silent omission must never read as complete coverage to the reviewer).
      let out = body.length > MAX_DIFF_BYTES ? `${body.slice(0, MAX_DIFF_BYTES)}\n\n[diff truncated for review]` : body;
      const gaps: string[] = [];
      if (!trackedOk) gaps.push('tracked changes (git diff HEAD failed)');
      if (untracked.enumerationFailed) gaps.push('untracked files (git ls-files failed)');
      if (untracked.omitted > 0) gaps.push(`${untracked.omitted} untracked file(s) (exceeded the review size/time budget)`);
      // Annotate ONLY a real (non-empty) body. If there is no diff content we must
      // NOT manufacture a note-only "diff" — that would defeat runHostTurnReview's
      // empty check and let the manager "pass" a note. Instead leave `out` empty so
      // the `incomplete` flag drives the empty+incomplete → review-error branch.
      if (gaps.length > 0 && body.trim()) out += `\n\n[NOTE: review coverage is INCOMPLETE — omitted: ${gaps.join('; ')}]`;
      // incomplete drives the EMPTY-diff branch: empty + incomplete = acquisition
      // failure (surface as a review error → the hook re-fires), empty + complete =
      // genuinely no changes. incompleteReason carries git's own message for the UI.
      const incomplete = !trackedOk || untracked.enumerationFailed || untracked.omitted > 0;
      const incompleteReason = trackedFailReason ?? (untracked.enumerationFailed ? 'git ls-files (untracked enumeration) failed' : undefined);
      return { diff: out, incomplete, ...(incompleteReason ? { incompleteReason } : {}) };
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
    ...((): { host?: string } => {
      const h = hostFromEnv(env);
      return h ? { host: h } : {};
    })(),
    newId: () => randomUUID(),
  };
}
