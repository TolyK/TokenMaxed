/**
 * F4 — Cline PreToolUse file hook (the routing gate). Bundled EXTENSIONLESS as
 * `hooks/PreToolUse` (CJS + shebang: the VS Code extension requires an
 * executable named exactly `PreToolUse` on Unix, and an extensionless file
 * parses as CJS under node; the CLI honors the shebang). Windows uses the
 * sibling PreToolUse.ps1 wrapper.
 *
 * Contract (verified Cline CLI 3.x / extension 4.x, July 2026): the ONLY
 * blocking file hook on both surfaces. JSON payload on stdin; JSON control on
 * stdout — `{}` allows, `{ cancel: true, errorMessage }` DENIES the pending
 * tool call. The two surfaces name our delegate tool differently:
 *   - CLI/SDK: MCP tools are native `serverName__toolName` ⇒
 *     `tokenmaxed__router_delegate`, payload at `preToolUse.toolName`.
 *   - VS Code extension: the classic `use_mcp_tool` indirection with
 *     `parameters.server_name` + `parameters.tool_name`, payload fields
 *     snake_cased (`pre_tool_use.tool_name`).
 * Both shapes are handled (pure matcher in cline-gate.ts — kept OUT of this
 * entry so tests never execute the stdin read below); anything else passes
 * untouched. Same decision + reason as every other host's gate. Fail OPEN
 * (allow) on any error — this is a convenience backstop; core still enforces.
 */

import { readFileSync } from 'node:fs';

import { isDelegateCall } from './cline-gate.ts';
import type { ClinePreToolUsePayload } from './cline-gate.ts';
import { delegateDenyReason, denyReasonForHost } from './opencode-plugin.ts';
import { effectiveEnv } from './settings.ts';


function main(): void {
  let payload: ClinePreToolUsePayload = {};
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    /* no/invalid stdin ⇒ not our call */
  }
  if (!isDelegateCall(payload)) {
    process.stdout.write('{}');
    return;
  }
  const reason = delegateDenyReason(effectiveEnv(process.env));
  // Cline skills are invoked as /tokenmaxed-x ⇒ '-' dialect in the remediation.
  process.stdout.write(reason ? JSON.stringify({ cancel: true, errorMessage: denyReasonForHost(reason, '-') }) : '{}');
}

try {
  main();
} catch {
  // Fail open: never break the session over a backstop hook (core still enforces).
  process.stdout.write('{}');
}
