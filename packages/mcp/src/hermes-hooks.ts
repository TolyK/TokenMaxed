/**
 * F5 — the PURE parts of the Hermes shell hooks (kept OUT of the stdin-reading
 * entries so tests can import them without wedging on readFileSync(0) — the
 * hard-won Cline lesson).
 *
 * Hermes contracts (verified v0.18.x, July 2026):
 *   - Shell hooks are per-event subprocesses declared in ~/.hermes/config.yaml:
 *     JSON payload on stdin, JSON directive on stdout. FAIL OPEN by design
 *     (non-zero exit / timeout / malformed JSON ⇒ warning, the event proceeds)
 *     — fine for us: every TokenMaxed hook is a convenience backstop.
 *   - MCP tools surface as `mcp_<server>_<tool>` ⇒ mcp_tokenmaxed_router_delegate.
 *   - pre_tool_call veto: {"decision":"block","reason":...}.
 *   - pre_llm_call may return {"context": "..."} appended to the user message —
 *     the ONLY injection point (session-start hooks are observational), so the
 *     banner self-gates to once per session via a tmp marker file.
 *   - pre_verify (Hermes ≥ 0.18.0): fires when the agent would accept a final
 *     answer on a turn that EDITED CODE; {"action":"continue","message":...}
 *     forces another agent iteration. `extra.attempt` counts nudges within the
 *     turn and agent.max_verify_nudges (default 3) caps host-side — so the
 *     hook uses `attempt` as the prior-rounds input to the same pure
 *     stopHookAction decision every other host uses (no counter file needed).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseMaxRounds } from './reviewer.ts';

/** The delegate tool as Hermes names it (mcp_<server>_<tool>). */
export const HERMES_DELEGATE_TOOL = 'mcp_tokenmaxed_router_delegate';

/**
 * The review budget for the INLINE pre_verify review: Hermes clamps shell-hook
 * timeouts to 300s max. What this bounds EXACTLY is diff acquisition + the CLI
 * reviewer (makeHostReviewDeps derives the spawnSync timeout from it); a few
 * further steps sit OUTSIDE it — the lane availability probe (hard ~700ms
 * internal cap in availability.ts), small local config-file reads, and the
 * one-line JSON I/O — so 260s keeps the worst-case total comfortably under
 * the clamp with ~39s of slack. (The recipe pins `timeout: 300`.)
 */
export const HERMES_VERIFY_BUDGET_MS = 260_000;

export interface HermesHookPayload {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  session_id?: unknown;
  extra?: Record<string, unknown>;
}

/** Pure: is this pre_tool_call payload a call to OUR delegate tool? */
export function isHermesDelegateCall(payload: HermesHookPayload): boolean {
  return payload.tool_name === HERMES_DELEGATE_TOOL;
}

/**
 * Pure: the sanitized session key for marker files ('default' when absent).
 * An 8-char hash of the RAW id disambiguates sanitization collisions (`a/b`
 * vs `a:b` would otherwise both become `a_b` and suppress each other's banner).
 */
export function hermesSessionKey(payload: HermesHookPayload): string {
  const raw = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : 'default';
  return raw.replace(/[^A-Za-z0-9_.-]/g, '_') + '-' + createHash('sha1').update(raw).digest('hex').slice(0, 8);
}

/**
 * Hermes stops honoring `continue` after agent.max_verify_nudges (default 3),
 * so a LARGER TokenMaxed round cap would mean our explicit yield/notify state
 * is never reached — the host just accepts silently. Cap at the HOST's nudge
 * limit: the default 3, or TOKENMAXED_HERMES_VERIFY_NUDGES when the operator
 * raised agent.max_verify_nudges (set both together — the recipe says so).
 */
export const HERMES_MAX_VERIFY_NUDGES_DEFAULT = 3;
export function hermesMaxRounds(env: Record<string, string | undefined>): number {
  // The hook can't read agent.max_verify_nudges; when the operator raises it
  // host-side they mirror the number in TOKENMAXED_HERMES_VERIFY_NUDGES.
  const raw = env.TOKENMAXED_HERMES_VERIFY_NUDGES;
  const nudges = raw !== undefined && /^[0-9]+$/.test(raw) && Number.parseInt(raw, 10) >= 1
    ? Number.parseInt(raw, 10)
    : HERMES_MAX_VERIFY_NUDGES_DEFAULT;
  return Math.min(parseMaxRounds(env), nudges);
}

/** Pure: the prior verify-nudge count from the payload (strict; garbage ⇒ 0). */
export function hermesVerifyAttempt(payload: HermesHookPayload): number {
  const raw = payload.extra?.attempt;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : 0;
}

/**
 * Once-per-session banner gate via a tmp marker file (each hook invocation is
 * a fresh subprocess, so in-memory state can't work). Returns true EXACTLY
 * once per session key; any filesystem error ⇒ false (skip the banner rather
 * than risk repeating it every turn). Markers accumulate until the OS cleans
 * its temp dir (reboot/periodic) — one tiny file per session, accepted.
 */
export function claimBannerMarker(sessionKey: string, dir: string = join(tmpdir(), 'tokenmaxed-banner')): boolean {
  try {
    const marker = join(dir, sessionKey);
    if (existsSync(marker)) return false;
    mkdirSync(dir, { recursive: true });
    // 'wx' is atomic-exclusive: a concurrent duplicate loses instead of double-bannering.
    writeFileSync(marker, '1', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}
