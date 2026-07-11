/**
 * F2 — the TokenMaxed OpenCode plugin (bundled by packages/opencode-plugin into
 * a single file users drop into `.opencode/plugin/` or the global plugin dir).
 *
 * OpenCode surface mapping (contracts verified against opencode v1.17, July 2026;
 * plugins run IN-PROCESS under Bun and receive an SDK client):
 *   - Session banner  → `chat.message`: OpenCode has no SessionStart hook, so the
 *     first user message of each session gets the same clamped summary banner
 *     appended as an extra text part (once per session, in-memory guard).
 *   - Routing gate    → `tool.execute.before`: deny-by-THROW is OpenCode's
 *     documented block mechanism; same decision logic as the Claude/Codex
 *     PreToolUse hooks (project toggle + kill-switch), same reason text.
 *   - Review loop     → `event` on `session.idle`: OpenCode has NO Stop-block
 *     equivalent — `session.idle` is fire-and-forget, so a non-pass review
 *     cannot veto the turn. HONEST REDUCED-PROTECTION MAPPING: the review runs
 *     in a CHILD process (tokenmaxed-review.mjs, bundled next to this plugin —
 *     the review path is deliberately spawnSync-based and would freeze
 *     OpenCode's shared event loop if run in-process), which applies the SAME
 *     pure `stopHookAction` decision (per-session counter, maxRounds yield,
 *     never-stuck write-failure rule) and prints one action. The plugin
 *     translates it: block ⇒ the reviewer notes are sent back into the session
 *     as a follow-up prompt (`client.session.prompt`), triggering a rework
 *     turn; notify ⇒ toast; prompt-back missing/failing ⇒ toast — the turn is
 *     never silently un-reviewed, but it also can't be BLOCKED the way Claude
 *     Code / Codex Stop hooks block. Documented in the README.
 *
 * Host identity: everything runs with TOKENMAXED_HOST defaulted to `opencode`
 * (explicit env wins) WITHOUT mutating the host process env — hosts:-scoped
 * lanes (e.g. the claude-CLI lanes) therefore fail closed here unless the user
 * deliberately lists `opencode`.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PRETOOLUSE_DENY_REASON, preToolUseDecision } from './hook.ts';
import { REVIEW_BUDGET_MS } from './host-review.ts';
import type { OpencodeReviewAction } from './opencode-review-main.ts';
import { reviewLoopEnabled } from './reviewer.ts';
import { homeFile } from './config.ts';
import { effectiveEnv } from './settings.ts';
import { makeSummaryFromEnv } from './summary-deps.ts';
import { clampBanner, formatSummaryBanner } from './summary.ts';
import { readEnabled } from './toggle.ts';
import type { ToggleStore } from './toggle.ts';

/** OpenCode's sanitized MCP tool name for our delegate tool (server_tool). */
export const OPENCODE_DELEGATE_TOOL = 'tokenmaxed_router_delegate';

/** Marker prefixed to the rework prompt so users can see why a turn continued. */
export const REWORK_PROMPT_PREFIX = '[TokenMaxed review — rework requested] ';

// Minimal structural types for the OpenCode plugin surface (the real ones live
// in @opencode-ai/plugin; we keep this bundle dependency-free and defensive).
interface OpencodeTextPart {
  type: 'text';
  text: string;
  [k: string]: unknown;
}
interface OpencodeClient {
  session?: {
    prompt?: (args: { path: { id: string }; body: { parts: OpencodeTextPart[] } }) => Promise<unknown>;
  };
  tui?: {
    showToast?: (args: { body: { message: string; variant: 'info' | 'warning' | 'error' } }) => Promise<unknown>;
  };
  [k: string]: unknown;
}
export interface OpencodePluginInput {
  client: OpencodeClient;
  directory: string;
  [k: string]: unknown;
}
export interface OpencodeHooks {
  'chat.message'?: (
    input: { sessionID?: string },
    output: { message: unknown; parts: OpencodeTextPart[] },
  ) => Promise<void>;
  'tool.execute.before'?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => Promise<void>;
  event?: (input: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>;
}

/**
 * The plugin's effective env: process env (settings-filled) with the host id
 * defaulted to `opencode` and the project key defaulted to the workspace dir —
 * WITHOUT mutating process.env (the plugin shares the host process).
 */
export function opencodePluginEnv(processEnv: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  const env = effectiveEnv(processEnv);
  return {
    ...env,
    TOKENMAXED_HOST: env.TOKENMAXED_HOST?.trim() ? env.TOKENMAXED_HOST : 'opencode',
    TOKENMAXED_PROJECT: env.TOKENMAXED_PROJECT ?? directory,
    // The REAL workspace path for diff acquisition — TOKENMAXED_PROJECT is only
    // a toggle KEY (may be logical); host-review consumes TOKENMAXED_PROJECT_DIR.
    TOKENMAXED_PROJECT_DIR: env.TOKENMAXED_PROJECT_DIR ?? directory,
  };
}

/**
 * The same deterministic gate the Claude/Codex PreToolUse hooks apply, as a
 * throwable reason: null ⇒ allow; string ⇒ deny with that reason (OpenCode
 * blocks a tool call by THROWING from tool.execute.before). Fail OPEN like the
 * other hosts — this is a convenience backstop; core still enforces.
 */
export function delegateDenyReason(env: NodeJS.ProcessEnv): string | null {
  try {
    // Same default state file the MCP server's toggle store writes (~/.tokenmaxed),
    // so /tokenmaxed-off is honored here too (OpenCode has no CLAUDE_PLUGIN_DATA).
    const statePath = env.TOKENMAXED_STATE ?? homeFile('state.json');
    const projectKey = env.TOKENMAXED_PROJECT ?? 'default';
    const disabledByEnv = env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true';
    const store: ToggleStore = {
      read: () => {
        if (!statePath || !existsSync(statePath)) return {};
        try {
          return JSON.parse(readFileSync(statePath, 'utf8'));
        } catch {
          return {};
        }
      },
      write: () => {},
    };
    const enabled = !disabledByEnv && readEnabled(store, projectKey);
    return preToolUseDecision(enabled) ? PRETOOLUSE_DENY_REASON : null;
  } catch {
    return null; // fail open — never break the session over a backstop
  }
}

/** Injected I/O for {@link makeIdleReviewHandler} (real impls wired by TokenMaxed). */
export interface IdleReviewDeps {
  /** The plugin's effective env (host id + project dir threaded, never process.env). */
  env: () => NodeJS.ProcessEnv;
  /**
   * Run the review for a session and return the terminal action. The real impl
   * spawns the bundled tokenmaxed-review.mjs child (counter machinery lives
   * there); throws ⇒ the review could not RUN (surfaced, never silent).
   */
  runReview: (sessionID: string, env: NodeJS.ProcessEnv) => Promise<OpencodeReviewAction>;
  /** Send a rework prompt back into the session; absent ⇒ this host client can't. */
  promptBack?: (sessionID: string, text: string) => Promise<unknown>;
  /** Best-effort user-visible notice (toast). Must never throw. */
  toast: (message: string) => Promise<void>;
}

/**
 * The session.idle review flow, extracted for direct unit testing (the plugin
 * closure only wires real I/O into it). Exactly one review per session at a
 * time; every non-allow outcome is SURFACED (prompt-back, else toast) — reduced
 * protection vs a blocking Stop hook, but never silently un-reviewed.
 */
export function makeIdleReviewHandler(deps: IdleReviewDeps): (sessionID: string) => Promise<void> {
  const reviewing = new Set<string>();
  return async (sessionID: string): Promise<void> => {
    if (reviewing.has(sessionID)) return;
    const env = deps.env();
    if (!reviewLoopEnabled(env)) return;
    reviewing.add(sessionID);
    try {
      let action: OpencodeReviewAction;
      try {
        action = await deps.runReview(sessionID, env);
      } catch (e) {
        // The review could not RUN (child missing/crashed) — surface it rather
        // than silently skipping the protection (Protection C analogue).
        await deps.toast(`⚠ TokenMaxed: turn review could not run (${e instanceof Error ? e.message : String(e)}).`);
        return;
      }
      if (action.kind === 'allow') return;
      if (action.kind === 'notify') {
        await deps.toast(action.message);
        return;
      }
      // 'block' — the honest OpenCode analogue is a rework prompt-back. A
      // missing prompt API must NOT look like success (the child already
      // incremented the loop counter): surface the notes instead.
      if (!deps.promptBack) {
        await deps.toast('⚠ TokenMaxed review (rework requested; this client cannot re-prompt): ' + action.reason);
        return;
      }
      try {
        await deps.promptBack(sessionID, REWORK_PROMPT_PREFIX + action.reason);
      } catch {
        await deps.toast('⚠ TokenMaxed review (rework requested, prompt-back failed): ' + action.reason);
      }
    } finally {
      reviewing.delete(sessionID);
    }
  };
}

/** Hard parent-side backstop over the child's own internal budget. */
const REVIEW_CHILD_KILL_MS = REVIEW_BUDGET_MS + 30_000;

/** Spawn the bundled review child and parse its single-line JSON action. */
function spawnReviewChild(scriptPath: string, sessionID: string, env: NodeJS.ProcessEnv): Promise<OpencodeReviewAction> {
  return new Promise((resolve, reject) => {
    if (!existsSync(scriptPath)) {
      reject(new Error(`review bundle not found next to the plugin: ${scriptPath} — copy plugin/tokenmaxed-review.mjs alongside plugin/tokenmaxed.js`));
      return;
    }
    const child = spawn(process.execPath, [scriptPath, sessionID], {
      env: env as Record<string, string>,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      fn();
    };
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      settle(() => reject(new Error('review child exceeded its budget')));
    }, REVIEW_CHILD_KILL_MS);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.on('error', (e) => settle(() => reject(e)));
    child.on('close', () =>
      settle(() => {
        try {
          const line = out.trim().split('\n').pop() ?? '';
          const parsed = JSON.parse(line) as OpencodeReviewAction;
          if (parsed.kind === 'allow' || parsed.kind === 'notify' || parsed.kind === 'block') {
            resolve(parsed);
            return;
          }
          reject(new Error('review child returned an unknown action'));
        } catch {
          reject(new Error('review child produced no parseable action'));
        }
      }),
    );
  });
}

/** How many session ids the banner / prune sets retain (the plugin is long-lived). */
const MAX_TRACKED_SESSIONS = 512;

/** The TokenMaxed OpenCode plugin (legacy named-export form — loads on v1.17). */
export const TokenMaxed = async (input: OpencodePluginInput): Promise<OpencodeHooks> => {
  // Bounded (the plugin lives as long as the OpenCode process): oldest-first
  // eviction past MAX_TRACKED_SESSIONS, plus pruning on session.deleted events.
  const bannered = new Set<string>();
  const remember = (id: string): void => {
    bannered.add(id);
    if (bannered.size > MAX_TRACKED_SESSIONS) {
      const oldest = bannered.values().next().value;
      if (oldest !== undefined) bannered.delete(oldest);
    }
  };
  const pluginEnv = (): NodeJS.ProcessEnv => opencodePluginEnv(process.env, input.directory);
  // The review child is bundled NEXT TO this plugin file (build.mjs emits both).
  const reviewScript = fileURLToPath(new URL('./tokenmaxed-review.mjs', import.meta.url));

  const toast = async (message: string, variant: 'info' | 'warning' | 'error' = 'warning'): Promise<void> => {
    try {
      await input.client.tui?.showToast?.({ body: { message, variant } });
    } catch {
      /* best-effort surface — never throw from a notification */
    }
  };

  const promptFn = input.client.session?.prompt;
  const handleIdle = makeIdleReviewHandler({
    env: pluginEnv,
    runReview: (sessionID, env) => spawnReviewChild(reviewScript, sessionID, env),
    // A missing prompt API must be VISIBLE as reduced protection, not fake success.
    ...(promptFn
      ? {
          promptBack: (sessionID: string, text: string) =>
            promptFn({ path: { id: sessionID }, body: { parts: [{ type: 'text', text }] } }),
        }
      : {}),
    toast,
  });

  return {
    // Session banner: once per session, appended to the first outgoing user
    // message (OpenCode has no session-start context hook). Same clamped string
    // the Claude SessionStart hook emits; silent under the kill-switch/errors.
    'chat.message': async (msgInput, output) => {
      try {
        const sessionID = msgInput.sessionID ?? (output.message as { sessionID?: string } | undefined)?.sessionID;
        if (!sessionID || bannered.has(sessionID)) return;
        remember(sessionID);
        const env = pluginEnv();
        if (env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true') return;
        const banner = clampBanner(formatSummaryBanner(await makeSummaryFromEnv(env)()));
        if (banner.trim()) output.parts.push({ type: 'text', text: banner });
      } catch {
        /* fail open — a banner must never break a message */
      }
    },

    // Routing gate: deterministic deny of router_delegate when routing is off
    // for this project (same decision + reason as the other hosts' hooks).
    'tool.execute.before': async (toolInput) => {
      if (toolInput.tool !== OPENCODE_DELEGATE_TOOL) return;
      const reason = delegateDenyReason(pluginEnv());
      if (reason) throw new Error(reason);
    },

    // Review loop on session.idle — see the module doc for the honest mapping.
    // The handler owns the per-session in-flight guard; the child owns the
    // loop counter. session.deleted prunes the banner set (long-lived process).
    event: async ({ event }) => {
      try {
        const props = event.properties ?? {};
        const sessionID =
          typeof props.sessionID === 'string'
            ? props.sessionID
            : typeof (props.info as { id?: unknown } | undefined)?.id === 'string'
              ? ((props.info as { id: string }).id)
              : undefined;
        if (event.type === 'session.deleted') {
          if (sessionID) bannered.delete(sessionID);
          return;
        }
        if (event.type !== 'session.idle' || !sessionID) return;
        await handleIdle(sessionID);
      } catch {
        /* fail open — event handling must never crash the host */
      }
    },
  };
};
