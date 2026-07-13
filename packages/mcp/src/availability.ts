/**
 * Lane availability probe (host I/O). Determines which configured lanes can
 * actually RUN right now, so routeDecide never selects a lane that would fail to
 * execute (e.g. a free local Ollama lane that wins on cost but isn't running).
 *
 * Per lane kind:
 *   - native  → always available (it's the host itself).
 *   - cli     → the `command` resolves on PATH (or an explicit path exists).
 *   - local   → the model server (Ollama) answers a quick GET on its endpoint.
 *   - api     → the BYOK key is present (resolveAuth returns non-empty). We do
 *               NOT make a network call per route — key presence is the cheap,
 *               deterministic availability proxy; a dead endpoint surfaces at
 *               execution as a normal lane failure (with fallback).
 *
 * Pure over its injected deps (PATH lookup, fetch, auth resolver) so it's
 * testable without a real environment.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Lane } from '@tokenmaxed/core';

import { makeResolveAuth, spawnPath } from './config.ts';

/** A minimal fetch shape (so tests can inject one without DOM types). */
type FetchLike = (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<{ ok: boolean }>;

const DEFAULT_OLLAMA_BASE = 'http://localhost:11434';
const LOCAL_PROBE_TIMEOUT_MS = 700; // a reachable local server answers instantly; bound a dead one

/** An executable regular file (not a directory, not a non-executable file)? */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false; // a dir on PATH is not a runnable command
    accessSync(candidate, constants.X_OK); // throws unless the file is executable
    return true;
  } catch {
    return false;
  }
}

/** Is `command` runnable — an absolute/relative executable, or a bare name resolvable on PATH? */
export function commandOnPath(command: string, path: string | undefined): boolean {
  if (!command) return false;
  if (command.includes('/')) return isExecutableFile(command);
  const dirs = (path ?? '').split(':').filter(Boolean);
  return dirs.some((dir) => isExecutableFile(join(dir, command)));
}

/** An existing regular file (not necessarily executable — node runs scripts that aren't +x)? */
function regularFileExists(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * For a `node <script.mjs> …` CLI lane (e.g. the antigravity companion), the `command`
 * being runnable (`node` on PATH) is NOT enough — the SCRIPT it runs must also exist, or
 * the lane spawns `node <missing/placeholder path>` and fails. So when the command is a
 * node runtime, require the first script-looking arg (an absolute/relative `.mjs`/`.js`
 * path, not a flag) to be a real file. This makes a template's `<ABSOLUTE-PATH-TO>/…`
 * placeholder — or a stale post-upgrade companion path — correctly report unavailable.
 * Lanes that aren't node-runners (codex, grok, claude, …) are unaffected.
 */
function nodeScriptArgPresent(lane: Lane): boolean {
  const base = (lane.command ?? '').split('/').pop();
  if (base !== 'node') return true; // not a node-runner lane — nothing extra to validate
  const scriptArg = (lane.args ?? []).find(
    (a) => !a.startsWith('-') && (a.endsWith('.mjs') || a.endsWith('.js')),
  );
  if (scriptArg === undefined) return true; // no script arg declared — leave it to the spawn
  return regularFileExists(scriptArg);
}

/** Quick reachability check for a local (Ollama) endpoint. Any non-error response ⇒ up. */
async function localReachable(base: string, fetchImpl: FetchLike | undefined): Promise<boolean> {
  if (!fetchImpl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base}/api/tags`, { method: 'GET', signal: controller.signal });
    return res.ok;
  } catch {
    return false; // connection refused / aborted / DNS ⇒ not running
  } finally {
    clearTimeout(timer);
  }
}

/** Injected I/O for {@link availableLaneIds}. */
export interface AvailabilityDeps {
  /** PATH used to resolve CLI commands (defaults to process.env.PATH at the call site). */
  path: string | undefined;
  /** Resolve a BYOK key by authHandle; '' ⇒ absent. */
  resolveAuth: (authHandle: string) => string;
  /** fetch implementation for local-server probes (defaults to globalThis.fetch). */
  fetchImpl?: FetchLike;
}

/** Whether a single lane is available to run now. */
export async function isLaneAvailable(lane: Lane, deps: AvailabilityDeps): Promise<boolean> {
  if (lane.native) return true;
  if (lane.kind === 'cli') return commandOnPath(lane.command ?? '', deps.path) && nodeScriptArgPresent(lane);
  if (lane.kind === 'local') return localReachable(lane.endpoint ?? DEFAULT_OLLAMA_BASE, deps.fetchImpl);
  if (lane.kind === 'api') return !!lane.authHandle && deps.resolveAuth(lane.authHandle).length > 0;
  return false; // unknown kind ⇒ fail closed (not selectable)
}

/** Ids of the lanes that can actually run right now (probed concurrently). */
export async function availableLaneIds(lanes: readonly Lane[], deps: AvailabilityDeps): Promise<string[]> {
  const results = await Promise.all(lanes.map(async (lane) => ((await isLaneAvailable(lane, deps)) ? lane.id : null)));
  return results.filter((id): id is string => id !== null);
}

/**
 * The one place that builds an availability probe from the environment (PATH +
 * namespaced BYOK auth + real fetch). Shared by routing (server), host-turn
 * review, and setup so they all agree on which lanes can run.
 */
export function makeAvailabilityDeps(env: NodeJS.ProcessEnv): AvailabilityDeps {
  const resolveAuth = makeResolveAuth(env);
  const fetchImpl = globalThis.fetch as unknown as FetchLike | undefined;
  // Use the SAME augmented PATH that makeCliSpawn spawns with — otherwise a CLI
  // installed beside Node (nvm/global-npm, e.g. codex) could be marked unavailable
  // under a stripped host PATH and never even reach the spawn that would find it.
  const path = spawnPath(process.execPath, env.PATH);
  return { path, resolveAuth, ...(fetchImpl ? { fetchImpl } : {}) };
}

export function makeAvailabilityProbe(env: NodeJS.ProcessEnv): (lanes: readonly Lane[]) => Promise<string[]> {
  const deps = makeAvailabilityDeps(env);
  return (lanes) => availableLaneIds(lanes, deps);
}
