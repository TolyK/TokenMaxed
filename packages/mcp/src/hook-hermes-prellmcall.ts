/**
 * F5 — Hermes pre_llm_call shell hook (the session banner). Bundled to
 * hooks/pre-llm-call.cjs. pre_llm_call is Hermes's ONLY context-injection
 * point (session-start hooks are observational): returning {"context": text}
 * appends it to the user message. Fires EVERY turn, so a tmp marker file
 * (fresh subprocess per event — no in-memory state) gates the banner to once
 * per session. Same clamped summary as every other host; silent under the
 * kill-switch; 5MB ledger budget guard; fails OPEN (empty) on any error.
 */

import { readFileSync } from 'node:fs';

import { claimBannerMarker, hermesSessionKey } from './hermes-hooks.ts';
import type { HermesHookPayload } from './hermes-hooks.ts';
import { bannerWithinBudget } from './opencode-plugin.ts';
import { effectiveEnv } from './settings.ts';
import { makeSummaryFromEnv } from './summary-deps.ts';
import { clampBanner, formatSummaryBanner } from './summary.ts';

async function main(): Promise<void> {
  let payload: HermesHookPayload = {};
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    /* fall through with defaults */
  }
  const env = effectiveEnv(process.env);
  if (env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true') {
    process.stdout.write('{}');
    return;
  }
  if (!claimBannerMarker(hermesSessionKey(payload)) || !bannerWithinBudget(env)) {
    process.stdout.write('{}');
    return;
  }
  let banner = '';
  try {
    banner = clampBanner(formatSummaryBanner(await makeSummaryFromEnv(env)()));
  } catch {
    /* fail open */
  }
  await writeStdout(banner.trim() ? JSON.stringify({ context: banner }) : '{}');
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
