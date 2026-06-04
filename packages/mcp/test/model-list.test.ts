/**
 * Tests for the hardened vendor /models query: URL derivation, the discriminated
 * result for every outcome, and the security constraints (https-only, redirect
 * rejection, capped/strict parse, auth required for BYOK lanes).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchModelList, modelsUrlFromEndpoint } from '../src/model-list.ts';
import type { Lane } from '@tokenmaxed/core';

const apiLane = (over: Partial<Lane> = {}): Lane => ({
  id: 'glm-api', kind: 'api', model: 'glm-5.1', trust_mode: 'worker', costBasis: 'metered',
  provenance: 'zhipu', jurisdiction: 'CN', endpoint: 'https://api.x.com/v1/chat/completions',
  authHandle: 'ZHIPU', ...over,
});
const key = () => 'sk-test';
const okResp = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

test('modelsUrlFromEndpoint derives /models, enforces https (except loopback)', () => {
  assert.equal(modelsUrlFromEndpoint('https://api.x.com/v1/chat/completions')?.toString(), 'https://api.x.com/v1/models');
  assert.equal(modelsUrlFromEndpoint('https://api.x.com/v1/models')?.toString(), 'https://api.x.com/v1/models');
  assert.equal(modelsUrlFromEndpoint('http://api.x.com/v1/chat/completions'), null); // non-https remote rejected
  assert.ok(modelsUrlFromEndpoint('http://localhost:1234/v1/chat/completions')); // loopback http ok
  assert.equal(modelsUrlFromEndpoint('https://api.x.com/weird/path'), null); // unrecognized shape
  assert.equal(modelsUrlFromEndpoint('not a url'), null);
  // Embedded credentials must be rejected (they'd ride in the request URL).
  assert.equal(modelsUrlFromEndpoint('https://user:pass@api.x.com/v1/chat/completions'), null);
});

test('issues a GET with no body, redirect:manual, accept + bearer header', async () => {
  let init: { method?: string; headers?: Record<string, string>; redirect?: string; body?: unknown } | undefined;
  await fetchModelList(apiLane(), {
    resolveAuth: key,
    fetchImpl: async (_u, i) => {
      init = i as typeof init;
      return okResp({ data: [{ id: 'a' }] });
    },
  });
  assert.equal(init?.method, 'GET');
  assert.equal(init?.redirect, 'manual');
  assert.equal(init?.headers?.accept, 'application/json');
  assert.equal(init?.headers?.authorization, 'Bearer sk-test');
  assert.equal('body' in (init ?? {}), false); // never sends a request body
});

test('caps the parsed list at MAX_MODELS (500)', async () => {
  const many = Array.from({ length: 600 }, (_v, i) => ({ id: `m${i}` }));
  const r = await fetchModelList(apiLane(), { resolveAuth: key, fetchImpl: async () => okResp({ data: many }) });
  assert.equal(r.status === 'ok' && r.models.length, 500);
});

test('a slow body read is bounded by the deadline (timeout, not hang)', async () => {
  // json() never resolves until the abort fires ⇒ must classify as timeout.
  const r = await fetchModelList(apiLane(), {
    resolveAuth: key,
    timeoutMs: 5,
    fetchImpl: async (_u, i) => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_res, rej) =>
          i.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
        ),
    }),
  });
  assert.equal(r.status, 'timeout');
});

test('ok: parses OpenAI {data:[...]} and a bare array', async () => {
  const r = await fetchModelList(apiLane(), { resolveAuth: key, fetchImpl: async () => okResp({ data: [{ id: 'glm-5.1', created: 1 }, { id: 'glm-6' }] }) });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.status === 'ok' && r.models, [{ id: 'glm-5.1', created: 1 }, { id: 'glm-6' }]);
  const bare = await fetchModelList(apiLane(), { resolveAuth: key, fetchImpl: async () => okResp([{ id: 'a' }]) });
  assert.equal(bare.status, 'ok');
});

test('ok-empty when the list has no usable entries', async () => {
  const r = await fetchModelList(apiLane(), { resolveAuth: key, fetchImpl: async () => okResp({ data: [] }) });
  assert.equal(r.status, 'ok-empty');
});

test('auth-missing when a BYOK lane has no key (and no fetch is made)', async () => {
  let called = false;
  const r = await fetchModelList(apiLane(), { resolveAuth: () => '', fetchImpl: async () => { called = true; return okResp({ data: [] }); } });
  assert.equal(r.status, 'auth-missing');
  assert.equal(called, false);
});

test('timeout vs offline are distinguished', async () => {
  const timeout = await fetchModelList(apiLane(), {
    resolveAuth: key,
    timeoutMs: 5,
    fetchImpl: (_u, init) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  assert.equal(timeout.status, 'timeout');
  const offline = await fetchModelList(apiLane(), { resolveAuth: key, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(offline.status, 'offline');
});

test('malformed on bad JSON or unexpected shape; unsupported on redirect / non-2xx', async () => {
  const badJson = await fetchModelList(apiLane(), { resolveAuth: key, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } }) });
  assert.equal(badJson.status, 'malformed');
  const badShape = await fetchModelList(apiLane(), { resolveAuth: key, fetchImpl: async () => okResp({ nope: true }) });
  assert.equal(badShape.status, 'malformed');
  const redirect = await fetchModelList(apiLane(), { resolveAuth: key, fetchImpl: async () => ({ ok: false, status: 302, json: async () => ({}) }) });
  assert.equal(redirect.status, 'unsupported');
  const notFound = await fetchModelList(apiLane(), { resolveAuth: key, fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.equal(notFound.status, 'unsupported');
});

test('unsupported for non-api lanes or a non-derivable endpoint', async () => {
  const cli = await fetchModelList({ ...apiLane(), kind: 'cli', endpoint: undefined, command: 'x' }, { resolveAuth: key, fetchImpl: async () => okResp({ data: [] }) });
  assert.equal(cli.status, 'unsupported');
  const weird = await fetchModelList(apiLane({ endpoint: 'https://api.x.com/weird' }), { resolveAuth: key, fetchImpl: async () => okResp({ data: [] }) });
  assert.equal(weird.status, 'unsupported');
});
