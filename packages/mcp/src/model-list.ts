/**
 * Vendor model-list query for MODEL-FRESHNESS (`@latest` resolution + staleness).
 * A bounded, hardened `GET <endpoint>/models` against an OpenAI-compatible provider.
 * This is the ONLY new egress the feature adds, so it is tightly constrained:
 *   - https only (except explicit loopback for local/dev),
 *   - URL built with the URL API (never string concat),
 *   - short abort timeout, redirects rejected, response strictly parsed + capped,
 *   - sends only the API key (Authorization) — NO prompt/repo/task content.
 * The caller decides WHEN to run it — only the explicit, networked /tokenmaxed:status
 * (NOT the routing path: @latest resolves purely from the price table, no egress, and
 * NOT the session-start summary, which is cache-only). It gates to enabled, keyed api
 * lanes. Pure over an injected fetch.
 */

import type { Lane } from '@tokenmaxed/core';

/** A model as reported by the vendor's /models list. */
export interface RemoteModel {
  id: string;
  /** OpenAI `created` (epoch seconds), when present — used to order newest-first. */
  created?: number;
}

/** Discriminated outcome — warnings + fail-open behavior differ per case. */
export type ModelListResult =
  | { status: 'ok'; models: RemoteModel[] }
  | { status: 'ok-empty' }
  | { status: 'offline' } // network error / connection refused / DNS
  | { status: 'auth-missing' } // a BYOK lane with no resolvable key
  | { status: 'timeout' } // exceeded the abort deadline
  | { status: 'malformed' } // non-JSON or unexpected shape
  | { status: 'unsupported' }; // no endpoint, non-derivable URL, non-https, redirect, or non-2xx

interface ModelFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
type ModelFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal; redirect?: 'manual' | 'error' | 'follow' },
) => Promise<ModelFetchResponse>;

export interface ModelListDeps {
  resolveAuth: (authHandle: string) => string;
  fetchImpl?: ModelFetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_MODELS = 500; // cap a hostile/huge response

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Derive the `/models` URL from a chat-completions endpoint. Returns null when it
 * can't be derived safely (non-https & non-loopback, or an unrecognized path shape).
 */
export function modelsUrlFromEndpoint(endpoint: string): URL | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  // Reject embedded credentials (https://user:pass@host/...) — they'd travel in the
  // request URL, undermining the "only the API key leaves" guarantee.
  if (url.username || url.password) return null;
  const isLoopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(isLoopback && url.protocol === 'http:')) return null;
  if (url.pathname.endsWith('/chat/completions')) {
    url.pathname = url.pathname.slice(0, -'/chat/completions'.length) + '/models';
  } else if (url.pathname.endsWith('/models')) {
    // already a models URL — keep it
  } else {
    return null; // unrecognized shape; don't guess
  }
  url.search = '';
  url.hash = '';
  return url;
}

/** Parse a /models JSON body (OpenAI `{data:[...]}` or a bare array) into RemoteModels. */
function parseModels(body: unknown): RemoteModel[] | null {
  const arr = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : null;
  if (!arr) return null;
  const out: RemoteModel[] = [];
  for (const entry of arr.slice(0, MAX_MODELS)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || id === '') continue;
    const created = (entry as { created?: unknown }).created;
    out.push(typeof created === 'number' && Number.isFinite(created) ? { id, created } : { id });
  }
  return out;
}

/** Query a lane's vendor model list. Never throws — returns a discriminated result. */
export async function fetchModelList(lane: Lane, deps: ModelListDeps): Promise<ModelListResult> {
  if (lane.kind !== 'api' || !lane.endpoint) return { status: 'unsupported' };
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as ModelFetch | undefined);
  if (!fetchImpl) return { status: 'offline' };

  let token = '';
  if (lane.authHandle) {
    try {
      token = deps.resolveAuth(lane.authHandle);
    } catch {
      token = '';
    }
    if (!token) return { status: 'auth-missing' };
  }

  const url = modelsUrlFromEndpoint(lane.endpoint);
  if (!url) return { status: 'unsupported' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // Keep the timer armed across BOTH the fetch and the body read: real fetch resolves
  // after headers, so a slow/huge body must stay under the same deadline (aborting the
  // controller rejects an in-flight res.json()). Cleared once, after parsing.
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    let res: ModelFetchResponse;
    try {
      res = await fetchImpl(url.toString(), { method: 'GET', headers, signal: controller.signal, redirect: 'manual' });
    } catch (err) {
      return controller.signal.aborted || (err as { name?: string })?.name === 'AbortError'
        ? { status: 'timeout' }
        : { status: 'offline' };
    }
    if (res.status >= 300 && res.status < 400) return { status: 'unsupported' }; // redirect rejected
    if (!res.ok) return { status: 'unsupported' }; // 4xx/5xx (incl. a /models the provider lacks)

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      // A timeout that fires during a slow body read surfaces as an abort here.
      return controller.signal.aborted || (err as { name?: string })?.name === 'AbortError'
        ? { status: 'timeout' }
        : { status: 'malformed' };
    }
    const models = parseModels(body);
    if (!models) return { status: 'malformed' };
    return models.length === 0 ? { status: 'ok-empty' } : { status: 'ok', models };
  } finally {
    clearTimeout(timer);
  }
}
