/**
 * Model-freshness cache (versioned, plugin-data state file). Lets the session-start
 * summary show staleness from CACHE only — no passive `/models` egress on every
 * launch. Live refresh happens on explicit, gated commands (setup / status), which
 * write here; the summary reads here. Pure cache logic + thin JSON file I/O.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { RemoteModel } from './model-list.ts';

const CACHE_VERSION = 1;

/** One endpoint's last-seen model list + when it was checked (epoch ms). */
export interface FreshnessEntry {
  models: RemoteModel[];
  checkedAt: number;
}

/** The whole cache: per-endpoint entries under a schema version. */
export interface FreshnessCache {
  version: number;
  endpoints: Record<string, FreshnessEntry>;
}

export function emptyCache(): FreshnessCache {
  return { version: CACHE_VERSION, endpoints: Object.create(null) };
}

/** Coerce arbitrary parsed JSON into a clean cache (wrong shape / old version ⇒ empty). */
export function coerceCache(raw: unknown): FreshnessCache {
  if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== CACHE_VERSION) return emptyCache();
  const eps = (raw as { endpoints?: unknown }).endpoints;
  if (!eps || typeof eps !== 'object' || Array.isArray(eps)) return emptyCache();
  const out = emptyCache();
  for (const [endpoint, v] of Object.entries(eps as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const checkedAt = (v as { checkedAt?: unknown }).checkedAt;
    const models = (v as { models?: unknown }).models;
    if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt) || !Array.isArray(models)) continue;
    const clean: RemoteModel[] = [];
    for (const m of models) {
      const id = (m as { id?: unknown })?.id;
      if (typeof id !== 'string' || id === '') continue;
      const created = (m as { created?: unknown }).created;
      clean.push(typeof created === 'number' && Number.isFinite(created) ? { id, created } : { id });
    }
    out.endpoints[endpoint] = { models: clean, checkedAt };
  }
  return out;
}

/** Whether `entry` was checked within `ttlMs` of `now` (absent ⇒ stale). */
export function isFresh(entry: FreshnessEntry | undefined, now: number, ttlMs: number): boolean {
  return !!entry && now - entry.checkedAt < ttlMs && now >= entry.checkedAt;
}

export function getEntry(cache: FreshnessCache, endpoint: string): FreshnessEntry | undefined {
  return Object.hasOwn(cache.endpoints, endpoint) ? cache.endpoints[endpoint] : undefined;
}

/** Return a NEW cache with `endpoint`'s entry set to `models` checked at `now`. */
export function putEntry(cache: FreshnessCache, endpoint: string, models: RemoteModel[], now: number): FreshnessCache {
  const next = emptyCache();
  Object.assign(next.endpoints, cache.endpoints);
  next.endpoints[endpoint] = { models, checkedAt: now };
  return next;
}

/** Read the cache file (missing / unreadable / wrong shape ⇒ empty). */
export function readFreshnessCache(path: string): FreshnessCache {
  try {
    return existsSync(path) ? coerceCache(JSON.parse(readFileSync(path, 'utf8'))) : emptyCache();
  } catch {
    return emptyCache();
  }
}

/** Persist the cache (best-effort; never throw — a freshness cache is non-critical). */
export function writeFreshnessCache(path: string, cache: FreshnessCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  } catch {
    /* non-critical */
  }
}
