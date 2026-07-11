#!/usr/bin/env node
/**
 * A-6 — PreToolUse hook executable. Registered (plugin.json) on the
 * `router_delegate` tool. Reads the project's toggle state (same store/key the
 * server uses) plus the TOKENMAXED_DISABLE kill-switch; if routing is disabled,
 * prints a deny payload so Claude Code blocks the offload deterministically.
 *
 * Config comes from ENVIRONMENT, never spliced into the hook command string, so a
 * project directory containing shell metacharacters can't be reinterpreted:
 *   - TOKENMAXED_STATE   (else ${CLAUDE_PLUGIN_DATA}/state.json)
 *   - TOKENMAXED_PROJECT (else ${CLAUDE_PROJECT_DIR}, else "default")
 *
 * Output/exit follow Claude Code's hook contract: exit 0 always; allow ⇒ no
 * output, deny ⇒ JSON on stdout. Fail OPEN on unexpected errors / missing state
 * (allow) — the core boundary still protects against leaks; this is only a
 * convenience backstop.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { preToolUseDecision } from './hook.ts';
import { effectiveEnv } from './settings.ts';
import { readEnabled } from './toggle.ts';
import type { ToggleStore } from './toggle.ts';

function main(): void {
  // Drain stdin (the hook input JSON) so we never block the pipe; we don't need it.
  try {
    readFileSync(0, 'utf8');
  } catch {
    /* no stdin — fine */
  }

  const env = effectiveEnv(process.env);
  const statePath = env.TOKENMAXED_STATE ?? (env.CLAUDE_PLUGIN_DATA ? join(env.CLAUDE_PLUGIN_DATA, 'state.json') : '');
  const projectKey = env.TOKENMAXED_PROJECT ?? env.CLAUDE_PROJECT_DIR ?? 'default';
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
  const decision = preToolUseDecision(enabled);
  if (decision) process.stdout.write(JSON.stringify(decision));
}

try {
  main();
} catch {
  // Fail open: never break the session over a backstop hook (core still enforces).
}
process.exit(0);
