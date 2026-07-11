/**
 * F — host identity for per-host lane gating (core's `hostAllowsLane`).
 *
 * Each adapter's launch config sets TOKENMAXED_HOST to its lowercase host id
 * (`claude-code`, `codex-cli`, `cli`, ...); the bundles also default it at
 * entry so hook processes (which don't inherit the MCP server's env block)
 * carry the same identity. Absent/empty ⇒ undefined ⇒ any lane with a
 * `hosts:` allowlist FAILS CLOSED (missing identity grants less authority,
 * never more) while unrestricted lanes are unaffected.
 */
export function hostFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.TOKENMAXED_HOST?.trim().toLowerCase();
  return raw ? raw : undefined;
}
