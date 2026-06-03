/**
 * A-6 — PreToolUse perimeter backstop (pure decision).
 *
 * The real no-leak enforcement is core-by-construction (typed MinimizedPayload);
 * this hook is a PERIMETER BACKSTOP that makes `/tokenmaxed:off` a HARD block:
 * when routing is disabled for the project, Claude Code is told to DENY the
 * `router_delegate` tool call outright, regardless of whether the model honors
 * the advisory toggle. This module is pure (no I/O) so the decision is tested
 * directly; the executable (hook-pretooluse.ts) wires state + stdin to it.
 */

export const PRETOOLUSE_DENY_REASON =
  'TokenMaxed routing is disabled for this project (/tokenmaxed:off). Handle this task on the host model, or run /tokenmaxed:on to re-enable.';

/** The deny payload Claude Code's PreToolUse hook expects (exit 0 + this JSON). */
export interface PreToolUseDeny {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

/**
 * Decide a PreToolUse outcome for a router_delegate call: `null` ⇒ allow (no
 * output, exit 0); otherwise the deny payload to print. Deny exactly when routing
 * is disabled for the project.
 */
export function preToolUseDecision(routingEnabled: boolean): PreToolUseDeny | null {
  if (routingEnabled) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: PRETOOLUSE_DENY_REASON,
    },
  };
}
