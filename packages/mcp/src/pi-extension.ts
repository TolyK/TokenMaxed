/**
 * F6 — the TokenMaxed Pi extension (earendil-works/pi, the minimal terminal
 * coding agent). Bundled by packages/pi-extension into extension/index.ts —
 * pi loads extensions IN-PROCESS via jiti, so this module follows the same
 * laws as the OpenCode/OpenClaw plugins: never mutate process.env, never run
 * spawnSync on the event loop (the review runs in the shared child).
 *
 * Pi surface mapping (contracts verified at repo HEAD, July 2026 — pi has NO
 * native MCP, so the router tools register NATIVELY over the same in-process
 * deps the MCP server would expose; strictly more capable than bridging):
 *   - Tools          → pi.registerTool per router tool, named tokenmaxed_<name>
 *     (pi tool names surface verbatim). Parameters pass our JSON Schemas
 *     directly (structurally what typebox's Type.Unsafe returns); dispatch
 *     re-validates inputs regardless. EVERY execute runs in the tool CHILD
 *     (tokenmaxed-tool.mjs beside the bundle) — the trusted CLI executor is
 *     spawnSync-based and would freeze pi's TUI if run in-process.
 *   - Session banner → before_agent_start returning { message } — once per
 *     session (reset on session_start), same clamped summary string.
 *   - Routing gate   → tool_call event returning { block: true, reason } — a
 *     real veto; reason speaks pi's /skill:tokenmaxed-x command dialect.
 *   - Review loop    → pi has NO turn-end veto (turn_end is notification-only):
 *     HONEST REDUCED-PROTECTION MAPPING like OpenCode — on agent_settled the
 *     review runs in the shared CHILD (tokenmaxed-review.mjs beside the
 *     bundle) via the same parent-owned-counter handler; a block becomes a
 *     follow-up message (pi.sendUserMessage) that triggers a rework turn;
 *     failures surface via the UI, never silently.
 *   - STATUSLINE     → the headline: ctx.ui.setStatus('tokenmaxed', gauge)
 *     push-updated on session_start/turn_end/agent_settled — the same rolling
 *     quota gauge the Claude Code statusline shows. Guarded by ctx.hasUI.
 *
 * Host identity: TOKENMAXED_HOST defaults to `pi` (explicit env wins) without
 * touching process.env; hosts:-scoped lanes (the claude-CLI lanes) fail closed
 * here unless the user deliberately lists `pi`. ChatGPT-plan Codex use in pi
 * is officially endorsed by OpenAI (Codex for OSS names pi), so the codex-cli
 * lane runs unrestricted.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  eligibleLanes,
  evaluate,
  hostAllowsLane,
  modelMatchesPin,
  filterEventsSince,
  resolvedPriorFor,
  routeDecide,
  summarize,
  tokenStats,
  TASK_CATEGORIES,
  classifyTask,
  MIN_CLASSIFY_CONFIDENCE,
  CLASSIFY_FALLBACK_CATEGORY,
} from '@tokenmaxed/core';

import { bannerWithinBudget, delegateDenyReason, makeIdleReviewHandler } from './opencode-plugin.ts';
import { spawnReviewChild } from './review-child.ts';
import { effectiveEnv } from './settings.ts';
import { statuslineFromEnv } from './statusline.ts';
import { makeSummaryFromEnv } from './summary-deps.ts';
import { clampBanner, formatSummaryBanner } from './summary.ts';
import { createTools } from './tools.ts';
import type { CorePort, ToolDef, ToolResult } from './tools.ts';

// The PURE core port (same construction the tests use) — deliberately NOT
// server.ts's CORE: importing server.ts would drag the whole spawnSync-based
// executor stack into this in-process bundle.
const PURE_CORE: CorePort = {
  filterEventsSince,
  summarize,
  tokenStats,
  routeDecide,
  eligibleLanes,
  hostAllowsLane,
  modelMatchesPin,
  evaluate,
  taskCategories: TASK_CATEGORIES,
  classifyTask,
  MIN_CLASSIFY_CONFIDENCE,
  CLASSIFY_FALLBACK_CATEGORY,
  resolvedPriorFor,
};

/**
 * Tool executions can legitimately take MINUTES (a delegate leg is bounded by
 * per-lane CLI timeouts plus escalation legs) — the child gets a generous hard
 * kill as the backstop, not a pacing device.
 */
export const PI_TOOL_KILL_MS = 25 * 60_000;

/**
 * Spawn the bundled tool child and parse its single-line JSON ToolResult.
 * pi's AbortSignal (user cancelled the tool) kills the child immediately — a
 * cancelled delegate must not keep a (possibly paid) lane invocation running.
 */
export function spawnToolChild(
  scriptPath: string,
  name: string,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    if (!existsSync(scriptPath)) {
      reject(new Error(`tool bundle not found next to the extension: ${scriptPath}`));
      return;
    }
    const child = spawn(process.execPath, [scriptPath, name], {
      env: env as Record<string, string>,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    let settled = false;
    // Declared BEFORE the pre-aborted path can run settle() — clearing an
    // uninitialized const here was a TDZ ReferenceError (review finding).
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      settle(() => reject(new Error(`${name} cancelled`)));
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      settle(() => reject(new Error(`${name} exceeded its budget`)));
    }, PI_TOOL_KILL_MS);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.on('error', (e) => settle(() => reject(e)));
    child.on('close', () =>
      settle(() => {
        try {
          resolve(JSON.parse(out.trim().split('\n').pop() ?? '') as ToolResult);
        } catch {
          reject(new Error(`${name} produced no parseable result`));
        }
      }),
    );
    child.stdin.end(JSON.stringify(args ?? {}));
  });
}

/** Pi surfaces tool names verbatim — ours carry the tokenmaxed_ provenance prefix. */
export const PI_DELEGATE_TOOL = 'tokenmaxed_router_delegate';

/** Rewrite the shared deny reason's /tokenmaxed:x refs into pi's /skill: dialect. */
export function denyReasonForPi(reason: string): string {
  return reason.replaceAll(/\/tokenmaxed:([a-z-]+)/g, '/skill:tokenmaxed-$1');
}

/**
 * The extension's effective env: pi's process env (settings-filled) with the
 * host id defaulted to `pi`, the project dir defaulted to pi's cwd (pi is a
 * project-directory terminal agent), and the price table pinned to the copy
 * shipped beside the extension — WITHOUT mutating process.env.
 */
export function piExtensionEnv(processEnv: NodeJS.ProcessEnv, extensionDirUrl: string): NodeJS.ProcessEnv {
  const env = effectiveEnv(processEnv);
  return {
    ...env,
    TOKENMAXED_HOST: env.TOKENMAXED_HOST?.trim() ? env.TOKENMAXED_HOST : 'pi',
    TOKENMAXED_PROJECT: env.TOKENMAXED_PROJECT ?? process.cwd(),
    TOKENMAXED_PROJECT_DIR: env.TOKENMAXED_PROJECT_DIR ?? process.cwd(),
    // Reference data ships one level above extension/ (module-relative '../'
    // in the shared deps resolves there when registered by path); the explicit
    // pin also survives users copying the whole package dir elsewhere.
    TOKENMAXED_PRICES: env.TOKENMAXED_PRICES ?? fileURLToPath(new URL('../prices.seed.json', extensionDirUrl)),
  };
}

// Minimal structural types for pi's extension API (the real ones live in
// @earendil-works/pi-coding-agent; this bundle is dependency-free/defensive).
interface PiUi {
  setStatus?: (key: string, text: string | undefined) => void;
  notify?: (text: string) => void;
}
interface PiContext {
  hasUI?: boolean;
  ui?: PiUi;
  [k: string]: unknown;
}
export interface PiExtensionApi {
  on: (event: string, handler: (event: Record<string, unknown>, ctx: PiContext) => unknown) => void;
  registerTool: (def: Record<string, unknown>) => void;
  sendUserMessage?: (content: string, opts?: { deliverAs?: string }) => void;
  [k: string]: unknown;
}

/** Ledger small enough for a sync statusline read on the TUI event loop? */
function statuslineWithinBudget(env: NodeJS.ProcessEnv): boolean {
  return bannerWithinBudget(env); // same 5MB stat-based guard
}

/** Injectable seams for tests (the default export wires the real children). */
export interface PiExtensionOverrides {
  runTool?: (name: string, args: Record<string, unknown>, env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<ToolResult>;
  runReview?: Parameters<typeof makeIdleReviewHandler>[0]['runReview'];
  counter?: Parameters<typeof makeIdleReviewHandler>[0]['counter'];
}

/** The TokenMaxed pi extension factory (default export — pi's contract). */
export default function tokenMaxedPiExtension(pi: PiExtensionApi, overrides: PiExtensionOverrides = {}): void {
  const moduleUrl = import.meta.url;
  const env = (): NodeJS.ProcessEnv => piExtensionEnv(process.env, moduleUrl);
  const TOOLS: ToolDef[] = createTools(PURE_CORE);
  const reviewScript = fileURLToPath(new URL('./tokenmaxed-review.mjs', moduleUrl));
  // EVERY tool call runs in the tool child: the router's trusted CLI executor
  // is spawnSync-based, and a delegate executed in-process would freeze pi's
  // TUI for the whole lane run. Read-only tools ride the same path (uniform,
  // ~50ms child startup — negligible against any tool's real work).
  const toolScript = fileURLToPath(new URL('./tokenmaxed-tool.mjs', moduleUrl));
  const runTool =
    overrides.runTool ??
    ((name: string, args: Record<string, unknown>, e: NodeJS.ProcessEnv, signal?: AbortSignal) =>
      spawnToolChild(toolScript, name, args, e, signal));

  let bannered = false;
  let lastCtx: PiContext | undefined;
  let sessionKey = `pi-${Date.now().toString(36)}`;

  const surface = async (message: string): Promise<void> => {
    try {
      if (lastCtx?.hasUI) (lastCtx.ui?.notify ?? lastCtx.ui?.setStatus?.bind(null, 'tokenmaxed'))?.(message);
    } catch {
      /* best-effort */
    }
  };

  const handleSettled = makeIdleReviewHandler({
    env,
    runReview: overrides.runReview ?? ((sessionID, e) => spawnReviewChild(reviewScript, sessionID, e)),
    ...(overrides.counter ? { counter: overrides.counter } : {}),
    promptBack: async (sessionID, text) => {
      // A review that finishes AFTER a session switch/shutdown must never
      // deliver into the newer session (pi.sendUserMessage is session-global).
      // Throwing routes to the toast fallback — surfaced, never silent.
      if (sessionID !== sessionKey) throw new Error('session ended before the review completed');
      if (!pi.sendUserMessage) throw new Error('sendUserMessage unavailable');
      pi.sendUserMessage(text, { deliverAs: 'followUp' });
    },
    toast: surface,
  });

  const updateStatus = (ctx: PiContext): void => {
    try {
      if (!ctx.hasUI || !ctx.ui?.setStatus) return;
      const e = env();
      if (e.TOKENMAXED_DISABLE === '1' || e.TOKENMAXED_DISABLE === 'true') {
        ctx.ui.setStatus('tokenmaxed', undefined);
        return;
      }
      if (!statuslineWithinBudget(e)) {
        ctx.ui.setStatus('tokenmaxed', undefined); // clear rather than leave STALE text
        return;
      }
      ctx.ui.setStatus('tokenmaxed', statuslineFromEnv(e));
    } catch {
      /* fail open — the status bar must never wedge the TUI */
    }
  };

  // --- tools: every router tool, natively, over the shared in-process deps ----
  for (const def of TOOLS) {
    pi.registerTool({
      name: `tokenmaxed_${def.name}`,
      label: `TokenMaxed ${def.name}`,
      description: def.description,
      parameters: def.inputSchema, // plain JSON Schema (≡ Type.Unsafe at runtime); dispatch re-validates
      execute: async (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
        const result = await runTool(def.name, params ?? {}, env(), signal);
        if (result.isError) throw new Error(result.content[0]?.text ?? `${def.name} failed`);
        return {
          content: result.content,
          details: result.structuredContent ?? {},
        };
      },
    });
  }

  // --- events -----------------------------------------------------------------
  pi.on('session_start', (_event, ctx) => {
    bannered = false;
    sessionKey = `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    lastCtx = ctx;
    updateStatus(ctx);
  });

  // Session banner — once per session, injected as a persistent message.
  pi.on('before_agent_start', async (_event, ctx) => {
    lastCtx = ctx;
    try {
      if (bannered) return undefined;
      bannered = true;
      const e = env();
      if (e.TOKENMAXED_DISABLE === '1' || e.TOKENMAXED_DISABLE === 'true') return undefined;
      if (!bannerWithinBudget(e)) return undefined;
      const banner = clampBanner(formatSummaryBanner(await makeSummaryFromEnv(e)()));
      return banner.trim() ? { message: { customType: 'tokenmaxed-banner', content: banner, display: true } } : undefined;
    } catch {
      return undefined; // fail open — a banner must never break a turn
    }
  });

  // Routing gate — a real veto: block the delegate when routing is off.
  pi.on('tool_call', (event, ctx) => {
    lastCtx = ctx;
    try {
      const toolName = (event.toolName ?? event.tool_name ?? (event.toolCall as { name?: unknown } | undefined)?.name) as
        | string
        | undefined;
      if (toolName !== PI_DELEGATE_TOOL) return undefined;
      const reason = delegateDenyReason(env());
      return reason ? { block: true, reason: denyReasonForPi(reason) } : undefined;
    } catch {
      return undefined; // fail open — core still enforces
    }
  });

  // Review loop (reduced protection: pi has no turn-end veto — a block becomes
  // a follow-up rework message) + statusline refresh. agent_settled fires when
  // no retry/follow-up remains, so our own rework turn re-settles → re-review,
  // bounded by the shared parent-owned counter.
  pi.on('agent_settled', async (_event, ctx) => {
    lastCtx = ctx;
    updateStatus(ctx);
    await handleSettled(sessionKey);
  });

  pi.on('turn_end', (_event, ctx) => {
    lastCtx = ctx;
    updateStatus(ctx);
  });

  pi.on('session_shutdown', () => {
    lastCtx = undefined;
    sessionKey = `shutdown-${Date.now().toString(36)}`; // late reviews can't match a live session
  });
}
