/**
 * F3 — the TokenMaxed OpenClaw plugin (bundled by packages/openclaw-plugin into
 * a single file loaded IN-PROCESS by the OpenClaw Gateway via its native plugin
 * system: openclaw.plugin.json manifest + this entry's default export).
 *
 * OpenClaw surface mapping (contracts verified against openclaw 2026.6/2026.7
 * docs, July 2026 — a STRONGER surface than OpenCode):
 *   - Session banner  → `before_prompt_build` returning `{ prependContext }`,
 *     once per session (bounded in-memory guard keyed on the payload's session
 *     identifier; once per gateway process when none is present).
 *   - Routing gate    → `before_tool_call` returning `{ block: true,
 *     blockReason }` for `tokenmaxed__router_delegate` (OpenClaw's MCP tool
 *     naming is `server__tool`, double underscore) — a DECISION hook, so this
 *     is a real veto, same decision + reason as the other hosts' gates.
 *   - Review loop     → `before_agent_finalize` — OpenClaw HAS a Stop-hook
 *     equivalent: returning `{ action: 'revise', reason, retry: { instruction,
 *     maxAttempts } }` forces another model pass. The spawnSync-based review
 *     runs in the SAME child process the OpenCode adapter uses
 *     (tokenmaxed-review.mjs beside this plugin — the Gateway's event loop
 *     must never block); the child owns the per-session loop counter.
 *     The hook registers with its OWN `timeoutMs` (FINALIZE_HOOK_TIMEOUT_MS,
 *     covering the review-child budget), the plugin kills the child BEFORE
 *     that budget expires, and — decisively — the child is PURE (the parent
 *     owns the loop counter and banks a round only when it actually returns a
 *     revise), so a killed or abandoned child can never bank a phantom round
 *     regardless of timing skew. CONFIG REQUIREMENT (documented, enforced by
 *     OpenClaw): the operator must set
 *     `plugins.entries.tokenmaxed.hooks.allowConversationAccess: true`; the
 *     example config also pins `hooks.timeouts.before_agent_finalize` in case
 *     an operator policy clamps plugin-requested timeouts. Overriding it BELOW
 *     the review budget is unsupported (reviews would time out fail-open).
 *
 * Host identity: everything runs with TOKENMAXED_HOST defaulted to `openclaw`
 * (explicit env wins) WITHOUT mutating the Gateway's process.env. hosts:-scoped
 * lanes (the claude-CLI lanes) therefore fail closed here unless the user
 * deliberately lists `openclaw` — the right posture: OpenClaw's own claude-cli
 * backend is tolerated-but-not-formally-sanctioned as of June 2026, and the
 * situation reversed once already in April 2026.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { bannerWithinBudget, delegateDenyReason, REWORK_PROMPT_PREFIX } from './opencode-plugin.ts';
import { REVIEW_CHILD_KILL_MS, fileLoopCounter, spawnReviewChild } from './review-child.ts';
import type { LoopCounterStore } from './review-child.ts';
import type { ReviewChildAction } from './review-child-main.ts';
import { parseMaxRounds, reviewLoopEnabled } from './reviewer.ts';
import { effectiveEnv } from './settings.ts';
import { makeSummaryFromEnv } from './summary-deps.ts';
import { clampBanner, formatSummaryBanner } from './summary.ts';

/** OpenClaw's MCP tool name for our delegate tool (server__tool, double underscore). */
export const OPENCLAW_DELEGATE_TOOL = 'tokenmaxed__router_delegate';

// Minimal structural types for the OpenClaw plugin API (the real ones live in
// OpenClaw's SDK; this bundle is dependency-free and defensive).
interface OpenclawHookOpts {
  priority?: number;
  timeoutMs?: number;
}
export interface OpenclawPluginApi {
  on: (hookName: string, handler: (payload: Record<string, unknown>) => unknown, opts?: OpenclawHookOpts) => void;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
  [k: string]: unknown;
}

/**
 * The plugin's effective env: Gateway process env (settings-filled) with the
 * host id defaulted to `openclaw` — WITHOUT mutating process.env (the plugin
 * runs in-process in the Gateway). No TOKENMAXED_PROJECT_DIR default here: the
 * Gateway serves many surfaces and its cwd is not a workspace; the operator
 * sets it (or CLAUDE_PROJECT_DIR) explicitly when the review should target a
 * specific repo — host-review falls back to the Gateway cwd otherwise.
 */
export function openclawPluginEnv(processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = effectiveEnv(processEnv);
  return {
    ...env,
    TOKENMAXED_HOST: env.TOKENMAXED_HOST?.trim() ? env.TOKENMAXED_HOST : 'openclaw',
  };
}

/** Best-effort session identifier from an OpenClaw hook payload (shapes vary by hook). */
export function sessionKeyFrom(payload: Record<string, unknown>): string | undefined {
  for (const k of ['sessionKey', 'sessionId', 'sessionID']) {
    const v = payload[k];
    if (typeof v === 'string' && v) return v;
  }
  const session = payload.session as { key?: unknown; id?: unknown } | undefined;
  if (typeof session?.key === 'string' && session.key) return session.key;
  if (typeof session?.id === 'string' && session.id) return session.id;
  return undefined;
}

/** Bounded once-per-key guard (the Gateway is long-lived). */
const MAX_TRACKED_SESSIONS = 512;

/**
 * The `before_agent_finalize` decision from a review-child action — pure, so
 * the revise/finalize mapping is unit-testable. `undefined` ⇒ let the natural
 * answer stand; revise carries the reviewer notes as the retry instruction
 * with the SAME round cap the other hosts use.
 */
export function finalizeDecisionFor(
  action: ReviewChildAction,
  maxRounds: number,
): { action: 'revise'; reason: string; retry: { instruction: string; idempotencyKey: string; maxAttempts: number } } | undefined {
  if (action.kind === 'block') {
    return {
      action: 'revise',
      reason: 'TokenMaxed review requested rework',
      // The stable idempotencyKey makes OpenClaw treat successive revises as ONE
      // retry chain, so maxAttempts bounds the loop HOST-SIDE even when the
      // child's counter key is one-shot (keyless payloads).
      retry: { instruction: REWORK_PROMPT_PREFIX + action.reason, idempotencyKey: 'tokenmaxed-review', maxAttempts: maxRounds },
    };
  }
  return undefined; // allow AND notify ⇒ the natural answer stands (notify is surfaced via the logger)
}

/**
 * The finalize hook's self-requested budget: covers the child's kill budget
 * plus parsing/translation slack. The example config pins the same number.
 */
export const FINALIZE_HOOK_TIMEOUT_MS = REVIEW_CHILD_KILL_MS + 10_000;

/** Injected I/O for {@link makeFinalizeHandler} (real impls wired by register). */
export interface FinalizeDeps {
  env: () => NodeJS.ProcessEnv;
  runReview: (sessionID: string, env: NodeJS.ProcessEnv) => Promise<ReviewChildAction>;
  /** Best-effort operator-visible notice (Gateway logger). Must never throw. */
  surface: (message: string) => Promise<void>;
  /** The per-session loop counter (parent-owned). Defaults to the tmp-file store. */
  counter?: LoopCounterStore;
}

/**
 * The `before_agent_finalize` flow, extracted for direct unit testing. One
 * review per session at a time. The PARENT owns the loop counter (the child is
 * pure — a killed/abandoned child can never bank a phantom round): the prior
 * count rides into the child via env, and a round is banked HERE, only when a
 * revise decision is actually returned. Payloads WITHOUT a session key share
 * ONE stable per-plugin-instance counter key (`keyless-<uuid>`, minted once at
 * construction): bounded by OUR counter even if the host ignores retry
 * idempotency — a deliberate trade (rare keyless sessions share a round
 * budget) in favor of guaranteed boundedness; keyed sessions are unaffected.
 */
export function makeFinalizeHandler(deps: FinalizeDeps): (payload: Record<string, unknown>) => Promise<unknown> {
  const reviewing = new Set<string>();
  const counter = deps.counter ?? fileLoopCounter;
  const keylessKey = `keyless-${randomUUID()}`; // stable for this plugin instance
  return async (payload) => {
    try {
      const env = deps.env();
      if (!reviewLoopEnabled(env)) return undefined;
      const key = sessionKeyFrom(payload);
      const sessionID = key ?? keylessKey;
      if (reviewing.has(sessionID)) return undefined;
      reviewing.add(sessionID);
      try {
        const priorBlocks = counter.read(sessionID);
        let action: ReviewChildAction;
        try {
          action = await deps.runReview(sessionID, { ...env, TOKENMAXED_REVIEW_PRIOR_BLOCKS: String(priorBlocks) });
        } catch (e) {
          await deps.surface(`⚠ TokenMaxed: turn review could not run (${e instanceof Error ? e.message : String(e)}).`);
          return undefined;
        }
        if (action.kind === 'allow') {
          counter.write(sessionID, 0);
          return undefined;
        }
        if (action.kind === 'notify') {
          counter.write(sessionID, 0);
          await deps.surface(action.message);
          return undefined;
        }
        // Bank the round BEFORE returning the revise; if it can't persist, do
        // NOT iterate (the loop guard would be defeated) — surface instead.
        // ACCEPTED RESIDUAL: host abandonment is undetectable from inside a
        // hook — if an operator clamps the hook timeout BELOW our requested
        // budget (documented unsupported), a late-returning revise is dropped
        // by the host while the round stays banked. That mis-spends rounds but
        // can never loop or wedge: the counter monotonically reaches maxRounds
        // and the next review yields via notify (surfaced). Under supported
        // config the hook budget covers the child, so the case doesn't arise.
        if (!counter.write(sessionID, priorBlocks + 1)) {
          await deps.surface(
            '⚠ TokenMaxed: review wanted rework but the loop-state file could not be written; not revising to avoid a loop. Notes: ' + action.reason,
          );
          return undefined;
        }
        return finalizeDecisionFor(action, parseMaxRounds(env));
      } finally {
        reviewing.delete(sessionID);
      }
    } catch {
      return undefined; // fail open — never wedge finalize over the backstop
    }
  };
}

/**
 * The TokenMaxed OpenClaw plugin entry. The default export matches
 * `definePluginEntry({...})`'s shape (a plain registration object — the helper
 * is an identity/typing aid in OpenClaw's SDK, which this dependency-free
 * bundle cannot import; `openclaw plugins inspect tokenmaxed --runtime`
 * verifies a live install).
 */
export const tokenMaxedOpenclawPlugin = {
  id: 'tokenmaxed',
  name: 'TokenMaxed',
  description:
    'Quota-continuity router: offload right-sized subtasks to the cheapest capable, policy-allowed lane. Banner + routing gate + turn-end review.',
  register(api: OpenclawPluginApi): void {
    const bannered = new Set<string>();
    const remember = (id: string): void => {
      bannered.add(id);
      if (bannered.size > MAX_TRACKED_SESSIONS) {
        const oldest = bannered.values().next().value;
        if (oldest !== undefined) bannered.delete(oldest);
      }
    };
    const pluginEnv = (): NodeJS.ProcessEnv => openclawPluginEnv(process.env);
    // The review child is bundled NEXT TO this plugin file (build.mjs emits both).
    const reviewScript = fileURLToPath(new URL('./tokenmaxed-review.mjs', import.meta.url));
    const surface = async (message: string): Promise<void> => {
      try {
        api.logger?.warn?.(message);
      } catch {
        /* best-effort */
      }
    };
    // Session banner — once per session, prepended to the prompt build.
    api.on('before_prompt_build', async (payload) => {
      try {
        const key = sessionKeyFrom(payload) ?? 'gateway';
        if (bannered.has(key)) return undefined;
        remember(key);
        const env = pluginEnv();
        if (env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true') return undefined;
        if (!bannerWithinBudget(env)) return undefined; // never block the Gateway on a huge ledger
        const banner = clampBanner(formatSummaryBanner(await makeSummaryFromEnv(env)()));
        return banner.trim() ? { prependContext: banner } : undefined;
      } catch {
        return undefined; // fail open — a banner must never break a prompt
      }
    });

    // Routing gate — a real veto (decision hook): block router_delegate when
    // routing is off for this project (same decision + reason as other hosts).
    api.on('before_tool_call', (payload) => {
      try {
        if (payload.toolName !== OPENCLAW_DELEGATE_TOOL) return undefined;
        // delegateDenyReason defaults the state file to ~/.tokenmaxed itself.
        const reason = delegateDenyReason(pluginEnv());
        return reason ? { block: true, blockReason: reason } : undefined;
      } catch {
        return undefined; // fail open — core still enforces
      }
    });

    // Turn-end review — OpenClaw's real Stop-equivalent. The child owns the
    // loop counter (revise → another pass → finalize fires again → re-review
    // until pass or the counter/host cap yields). The hook requests its OWN
    // timeout covering the child budget, and the child is killed BEFORE that
    // budget (killAfterMs) so a timed-out hook can never bank a phantom round.
    const handleFinalize = makeFinalizeHandler({
      env: pluginEnv,
      runReview: (sessionID, env) =>
        spawnReviewChild(reviewScript, sessionID, env, { killAfterMs: FINALIZE_HOOK_TIMEOUT_MS - 10_000 }),
      surface,
    });
    api.on('before_agent_finalize', handleFinalize, { timeoutMs: FINALIZE_HOOK_TIMEOUT_MS });
  },
};

export default tokenMaxedOpenclawPlugin;
