/**
 * F5 — Hermes pre_tool_call shell hook (the routing gate). Bundled to
 * hooks/pre-tool-call.cjs; ~/.hermes/config.yaml runs it via
 * `command: "node /abs/path/pre-tool-call.cjs"` with `matcher` scoping it to
 * our delegate tool. stdin JSON in, stdout JSON out; deny =
 * {"decision":"block","reason"}. Hermes hooks FAIL OPEN on error/timeout —
 * acceptable: this is a convenience backstop; core still enforces. Same
 * decision + reason as every other host's gate, in Hermes's /tokenmaxed-x
 * command dialect (skills auto-become dash-named slash commands).
 */

import { readFileSync } from 'node:fs';

import { isHermesDelegateCall } from './hermes-hooks.ts';
import type { HermesHookPayload } from './hermes-hooks.ts';
import { delegateDenyReason, denyReasonForHost } from './opencode-plugin.ts';
import { effectiveEnv } from './settings.ts';

function main(): void {
  let payload: HermesHookPayload = {};
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    /* no/invalid stdin ⇒ not our call */
  }
  if (!isHermesDelegateCall(payload)) {
    process.stdout.write('{}');
    return;
  }
  const reason = delegateDenyReason(effectiveEnv(process.env));
  process.stdout.write(reason ? JSON.stringify({ decision: 'block', reason: denyReasonForHost(reason, '-') }) : '{}');
}

try {
  main();
} catch {
  process.stdout.write('{}'); // fail open — never break the session over a backstop
}
