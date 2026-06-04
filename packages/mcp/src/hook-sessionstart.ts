#!/usr/bin/env node
/**
 * SessionStart hook — primes the session with the TokenMaxed summary banner.
 *
 * Runs the SAME shared LOCAL summary code as /tokenmaxed:summary (makeSummaryFromEnv);
 * it does NOT call the MCP tool, because SessionStart can fire before the MCP server
 * has connected. Output is injected as additionalContext (per Claude Code hooks docs
 * it primes Claude's context, not a guaranteed visible terminal banner — the visible
 * surface is the /tokenmaxed:summary command).
 *
 * Guardrails: SILENT under the TOKENMAXED_DISABLE kill-switch; a routing-OFF variant
 * is shown for the persisted project toggle (handled inside buildSummaryData via the
 * `enabled` flag). Fails OPEN (silent) on any error so it can never disrupt startup.
 *
 * Cost is bounded by construction rather than an in-process timer (a JS timer can't
 * interrupt the synchronous config/ledger reads, so a deadline race would be a false
 * guarantee): the availability probe is internally capped (~700ms, concurrent with a
 * per-lane abort) and the lane/ledger reads are small LOCAL files. We do NOT read
 * stdin (reading fd 0 synchronously could block until EOF, and we don't need the
 * session JSON). Claude Code's own hook timeout is the hard backstop for a wedged disk.
 *
 * Contract: exit 0 always; emit nothing, or {"hookSpecificOutput":{...}} JSON.
 */

import { makeSummaryFromEnv } from './summary-deps.ts';
import { formatSummaryBanner } from './summary.ts';

async function main(): Promise<void> {
  const env = process.env;
  // Kill-switch ⇒ stay completely silent (no banner at all).
  if (env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true') return;

  let data;
  try {
    data = await makeSummaryFromEnv(env)();
  } catch {
    return; // fail open — silent on any error
  }

  const banner = formatSummaryBanner(data);
  await writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: banner } }));
}

/** Write to stdout and resolve only once it has been flushed to the OS. */
function writeStdout(s: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(s, () => resolve());
  });
}

main()
  .catch(() => {
    /* fail open — never let a summary banner disrupt session start */
  })
  .finally(() => process.exit(0));
