/**
 * F4 — Cline TaskStart file hook (the session banner). Bundled EXTENSIONLESS
 * as `hooks/TaskStart` (CJS + shebang; see hook-cline-pretooluse.ts for why).
 *
 * Surface honesty (verified July 2026): the VS Code extension runs TaskStart
 * BLOCKING (30s budget) and injects the returned `contextModification` into
 * the conversation — the banner works there. The CLI dispatches TaskStart
 * DETACHED and ignores its stdout, so the CLI gets NO session banner from this
 * hook (documented reduced surface; the /tokenmaxed-summary skill covers it on
 * demand). Emitting the same JSON on both surfaces is harmless — ignored
 * output is just ignored.
 *
 * Same clamped summary string as every other host's banner; SILENT under the
 * kill-switch; fails OPEN (empty output) on any error. The extension caps
 * contextModification at 50KB — clampBanner keeps us far below that.
 */

import { bannerWithinBudget } from './opencode-plugin.ts';
import { effectiveEnv } from './settings.ts';
import { makeSummaryFromEnv } from './summary-deps.ts';
import { clampBanner, formatSummaryBanner } from './summary.ts';

async function main(): Promise<void> {
  const env = effectiveEnv(process.env);
  if (env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true') {
    process.stdout.write('{}');
    return;
  }
  // The extension runs this hook BLOCKING with a 30s budget, and the summary's
  // ledger read is synchronous and uninterruptible — the same 5MB size guard
  // the in-process hosts use keeps a huge ledger from blowing that deadline.
  if (!bannerWithinBudget(env)) {
    process.stdout.write('{}');
    return;
  }
  let banner = '';
  try {
    banner = clampBanner(formatSummaryBanner(await makeSummaryFromEnv(env)()));
  } catch {
    /* fail open — silent on any error */
  }
  await writeStdout(banner.trim() ? JSON.stringify({ contextModification: banner }) : '{}');
}

function writeStdout(s: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(s, () => resolve());
  });
}

void (async () => {
  try {
    await main();
  } catch {
    process.stdout.write('{}');
  }
})();
