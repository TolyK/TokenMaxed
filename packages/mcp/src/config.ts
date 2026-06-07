/**
 * Shared config/runtime helpers used by the server and the hook executables, so
 * the security-sensitive pieces (namespaced auth, recursion-guarding spawn,
 * user-owned config location) have ONE definition and can't drift.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import type { Policy } from '@tokenmaxed/core';
import { loadPolicyConfig } from '@tokenmaxed/core/node';

/** User-owned config dir. Lanes/policy live here, NEVER the repo (RCE guard). */
export const HOME_TM = join(homedir(), '.tokenmaxed');

/** A file under the user-owned config dir. */
export function homeFile(name: string): string {
  return join(HOME_TM, name);
}

/**
 * Build a policy loader that FAILS CLOSED: an explicitly configured policy file
 * that's missing throws (don't silently allow more than intended); only the
 * DEFAULT path missing (pre-setup) falls back to {} (core deny-by-default still
 * applies). Shared by routing and review so both honor the same policy.
 */
export function makeLoadPolicy(env: NodeJS.ProcessEnv): () => Policy {
  const policyPath = env.TOKENMAXED_POLICY ?? homeFile('policy.yaml');
  const explicit = env.TOKENMAXED_POLICY !== undefined;
  return () => {
    if (existsSync(policyPath)) return loadPolicyConfig(policyPath);
    if (explicit) throw new Error(`configured policy file not found: ${policyPath}`);
    return {};
  };
}

/**
 * BYOK auth resolver, namespaced: a lane's `authHandle` resolves ONLY to env var
 * `TOKENMAXED_KEY_<handle>`, never an arbitrary name — so a repo-supplied
 * lanes.yaml can't name e.g. GITHUB_TOKEN and exfiltrate it. Unknown ⇒ '' (the
 * executor then fails closed). Handle must be a plain identifier.
 */
export function makeResolveAuth(env: NodeJS.ProcessEnv): (authHandle: string) => string {
  return (authHandle: string) => {
    if (!/^[A-Za-z0-9_]+$/.test(authHandle)) return '';
    return env[`TOKENMAXED_KEY_${authHandle}`] ?? '';
  };
}

/** Default CLI lane timeout: bounds a hung provider CLI (e.g. an auth prompt). */
export const DEFAULT_CLI_TIMEOUT_MS = 300_000;

/**
 * PATH for spawned CLI lanes. Prepends the directory of the running Node binary
 * (`process.execPath`) so a provider CLI installed ALONGSIDE it — the common case
 * for nvm / global-npm tools like `codex` and `gemini` — resolves even when the
 * plugin host/hook process was launched with a stripped PATH. Without this a bare
 * `command: codex` lane can fail to spawn (ENOENT) purely because the hook's PATH
 * doesn't carry the nvm bin, even though `codex` is installed. Dedupes if the dir
 * is already present, and tolerates an empty/undefined base PATH.
 */
export function spawnPath(execPath: string = process.execPath, base: string | undefined = process.env.PATH): string {
  const binDir = dirname(execPath);
  const parts = (base ?? '').split(delimiter).filter(Boolean);
  if (parts.includes(binDir)) return parts.join(delimiter);
  return [binDir, ...parts].join(delimiter);
}

/**
 * A CLI spawn hook (for makeCliExecutor) that (a) runs children with
 * TOKENMAXED_DISABLE=1 so a cheaper-Claude lane (`claude -p`) — or a Claude
 * manager — can't load this plugin and recurse, and (b) bounds them with a
 * `timeout` so a hung CLI can never block indefinitely (spawnSync is synchronous,
 * so an unbounded child would freeze the whole process / Stop hook).
 */
export function makeCliSpawn(timeoutMs: number = DEFAULT_CLI_TIMEOUT_MS): (
  command: string,
  args: readonly string[],
  options: { input: string; encoding: 'utf8'; maxBuffer: number },
) => { status: number | null; stdout?: string; error?: Error } {
  return (command, args, options) =>
    spawnSync(command, [...args], {
      ...options,
      // Augment PATH so a CLI installed next to this Node (nvm/global-npm) is found
      // even under a stripped host PATH; TOKENMAXED_DISABLE=1 stops child recursion.
      env: { ...process.env, PATH: spawnPath(), TOKENMAXED_DISABLE: '1' },
      timeout: timeoutMs,
    }) as {
      status: number | null;
      stdout?: string;
      error?: Error;
    };
}
