/**
 * Shared config/runtime helpers used by the server and the hook executables, so
 * the security-sensitive pieces (namespaced auth, recursion-guarding spawn,
 * user-owned config location) have ONE definition and can't drift.
 */

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
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
 * manager — can't load this plugin and recurse, (b) bounds them with a `timeout`
 * so a hung CLI can never block indefinitely (spawnSync is synchronous, so an
 * unbounded child would freeze the whole process / Stop hook), and (c) REAPS the
 * child's whole process GROUP after the call.
 *
 * (c) matters because a reviewer/worker CLI (notably `codex exec`, but also any
 * other lane) can fork a long-lived LISTENER / app-server / event loop that
 * outlives the one-shot call. Left unreaped, these accumulate system-wide and
 * exhaust spawn capacity — every later `codex exec` then fails with "cli lane
 * failed to spawn". We spawn the child `detached` (its own process group) and,
 * after spawnSync returns (normal exit OR timeout), reap the whole tree: on POSIX,
 * SIGKILL the process GROUP (`-pid`) — our own process is in a different group, so
 * this never touches the host; on Windows, `taskkill /T /F` the pid (no group
 * signals there). Fully daemonized grandchildren that `setsid` into their OWN
 * session are not reachable this way (documented limit; `codex exec` does not do
 * this for our reviews).
 *
 * SCOPE (two documented residuals): the reap runs AFTER spawnSync returns, so it
 * cleans up a listener that has already detached our stdio. A leaked child that
 * KEEPS our stdout/stderr pipe open instead keeps spawnSync itself blocked until
 * the `timeout` above fires (ETIMEDOUT) — that timeout, not the reap, is the
 * backstop for that case (codex's app-server doesn't hold our pipe, so reviews
 * return promptly). On Windows the post-exit `taskkill` is BEST-EFFORT only (if the
 * root pid already exited, descendants may be unreachable); the timeout is again
 * the real bound there. POSIX (the supported path) reaps the whole group reliably.
 */
export function makeCliSpawn(timeoutMs: number = DEFAULT_CLI_TIMEOUT_MS): (
  command: string,
  args: readonly string[],
  options: { input: string; encoding: 'utf8'; maxBuffer: number },
) => { status: number | null; stdout?: string; error?: Error; signal?: NodeJS.Signals | null } {
  return (command, args, options) => {
    // `detached` is honored by libuv for spawnSync (own process group) but is missing
    // from @types/node's SpawnSyncOptions, so widen the type explicitly.
    const spawnOptions: SpawnSyncOptions & { detached: boolean } = {
      ...options,
      // Augment PATH so a CLI installed next to this Node (nvm/global-npm) is found
      // even under a stripped host PATH; TOKENMAXED_DISABLE=1 stops child recursion.
      env: { ...process.env, PATH: spawnPath(), TOKENMAXED_DISABLE: '1' },
      timeout: timeoutMs,
      // Own process group so we can reap the WHOLE tree (listeners included) below.
      detached: true,
    };
    const res = spawnSync(command, [...args], spawnOptions) as {
      pid?: number;
      status: number | null;
      stdout?: string;
      error?: Error;
      signal?: NodeJS.Signals | null;
    };
    // Reap any listener/loop the CLI left running (normal exit or timeout). The
    // tree is usually already gone for a clean one-shot ⇒ ignore the resulting error.
    if (typeof res.pid === 'number') {
      try {
        if (process.platform === 'win32') {
          // Windows has no process-group signals; best-effort tree kill by PID.
          // `/T` catches descendants that still exist — but if the root pid already
          // exited, orphans may be unreachable (the `timeout` above is the real bound).
          spawnSync('taskkill', ['/pid', String(res.pid), '/t', '/f']);
        } else {
          // POSIX: SIGKILL the whole process GROUP (negative pid). Our own process
          // is in a different group, so this only reaps the child + what it spawned.
          process.kill(-res.pid, 'SIGKILL');
        }
      } catch {
        /* tree already exited — nothing to reap */
      }
    }
    return res;
  };
}
