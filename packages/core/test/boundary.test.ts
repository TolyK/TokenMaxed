import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildReaderRequestBody,
  buildUntrustedRequestBody,
  isExecutorCertified,
  isReaderExecutorCertified,
  READER_SYSTEM_FRAMING,
  WORKER_SYSTEM_FRAMING,
} from '../src/boundary.ts';
import { INSUFFICIENT_CONTEXT_SENTINEL } from '../src/access.ts';
import { minimize, minimizeForReader } from '../src/minimize.ts';
import type { SecretScanner } from '../src/minimize.ts';
import { executeReader, executeUntrusted } from '../src/node.ts';
import type { Lane } from '../src/types.ts';

const clean: SecretScanner = async () => ({ available: true, hasSecret: false });

async function genuinePayload() {
  const r = await minimize(
    { instruction: 'reverse a string', category: 'codegen', repo_class: 'public', sensitivity: 'normal' },
    clean,
  );
  assert.ok(r.ok);
  return r.payload;
}

const laneOf = (kind: Lane['kind']): Lane => ({
  id: 'x', kind, model: 'm', trust_mode: 'worker', costBasis: 'metered', provenance: 'acme', jurisdiction: 'US',
});

test('isExecutorCertified: the api (BYOK HTTP) executor is certified; cli/local are not', () => {
  assert.equal(isExecutorCertified(laneOf('api')), true);
  assert.equal(isExecutorCertified(laneOf('cli')), false);
  assert.equal(isExecutorCertified(laneOf('local')), false);
});

test('buildUntrustedRequestBody allowlists model + minimized content only', async () => {
  const payload = await genuinePayload();
  const env = { payload, lane: { id: 'LANEID_SENT', model: 'gpt-x', endpoint: 'https://fake.invalid', authHandle: 'AUTH_SENT' } };
  const body = buildUntrustedRequestBody(env);
  assert.deepEqual(Object.keys(body), ['model', 'messages']);
  assert.equal(body.model, 'gpt-x');
  const json = JSON.stringify(body);
  assert.ok(!json.includes('LANEID_SENT'));
  assert.ok(!json.includes('AUTH_SENT'));
  assert.ok(json.includes('reverse a string'));
});

test('buildUntrustedRequestBody prepends the worker framing carrying the give-back protocol', () => {
  // The framing is a constant system message ahead of the user content; it defines
  // the INSUFFICIENT_CONTEXT give-back so a blind worker can hand repo-tight work back.
  assert.ok(WORKER_SYSTEM_FRAMING.includes(INSUFFICIENT_CONTEXT_SENTINEL));
});

test('buildUntrustedRequestBody: system framing first, user content second; top-level keys unchanged', async () => {
  const payload = await genuinePayload();
  const env = { payload, lane: { id: 'L', model: 'gpt-x', endpoint: 'https://fake.invalid', authHandle: 'A' } };
  const body = buildUntrustedRequestBody(env);
  // The egress allowlist invariant holds: still only model + messages at the top level.
  assert.deepEqual(Object.keys(body), ['model', 'messages']);
  assert.equal(body.messages[0]!.role, 'system');
  assert.equal(body.messages[0]!.content, WORKER_SYSTEM_FRAMING);
  assert.equal(body.messages[1]!.role, 'user');
  assert.ok(body.messages[1]!.content.includes('reverse a string'));
});

test('egress-envelope CI: only model+content + resolved token leave; ids/handles never leak', async () => {
  const payload = await genuinePayload();
  const env = {
    payload,
    lane: { id: 'LANEID_SENT', model: 'gpt-x', endpoint: 'https://fake.invalid/v1/chat', authHandle: 'AUTH_HANDLE_SENT' },
  };
  let captured: { url: string; init: { headers: Record<string, string>; body: string } } | undefined;
  const fakeFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    };
  };
  const r = await executeUntrusted(env, { fetchImpl: fakeFetch, resolveAuth: () => 'RESOLVED_TOKEN' });
  assert.ok(r.ok);
  assert.equal(r.resultText, 'OK');
  assert.deepEqual(r.reported, { tokens_in: 10, tokens_out: 5 });

  assert.ok(captured);
  // URL is exactly the endpoint — no query identifiers appended.
  assert.equal(captured.url, 'https://fake.invalid/v1/chat');
  // The opaque authHandle and lane id never appear in ANY outbound channel.
  const everything = captured.url + JSON.stringify(captured.init.headers) + captured.init.body;
  assert.ok(!everything.includes('AUTH_HANDLE_SENT'));
  assert.ok(!everything.includes('LANEID_SENT'));
  // Only the RESOLVED token is sent, in the Authorization header.
  assert.equal(captured.init.headers.authorization, 'Bearer RESOLVED_TOKEN');
  // Body is exactly the allowlisted shape.
  assert.deepEqual(Object.keys(JSON.parse(captured.init.body)), ['model', 'messages']);
});

test('executeUntrusted refuses a forged (non-genuine) payload and never sends', async () => {
  const payload = await genuinePayload();
  const forged = { ...payload, instruction: 'raw /repo/secret code' }; // copyable brand, not genuine
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const r = await executeUntrusted(
    { payload: forged, lane: { id: 'x', model: 'm', endpoint: 'https://x', authHandle: 'h' } },
    { fetchImpl: fakeFetch },
  );
  assert.equal(r.ok, false);
  assert.equal(called, false); // refused before any network call
});

test('executeUntrusted returns a content-free error on transport failure', async () => {
  const payload = await genuinePayload();
  const boom = async () => {
    throw new Error('network failed reaching /Users/secret/path');
  };
  const r = await executeUntrusted(
    { payload, lane: { id: 'x', model: 'm', endpoint: 'https://x', authHandle: 'h' } },
    { fetchImpl: boom, resolveAuth: () => 'tok' },
  );
  assert.equal(r.ok, false);
  assert.ok(!String(r.error).includes('/Users')); // no raw content/path in the error
});

test('executeUntrusted fails closed when a lane needs auth but no resolver is provided', async () => {
  const payload = await genuinePayload();
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  // authHandle set but no resolveAuth ⇒ block before sending (no unauthenticated POST).
  const r = await executeUntrusted(
    { payload, lane: { id: 'x', model: 'm', endpoint: 'https://x', authHandle: 'needs-auth' } },
    { fetchImpl: fakeFetch },
  );
  assert.equal(r.ok, false);
  assert.equal(called, false);
  assert.match(String(r.error), /auth resolution failed/);
});

test('executeUntrusted fails content-free when auth resolution throws (and never sends)', async () => {
  const payload = await genuinePayload();
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const r = await executeUntrusted(
    { payload, lane: { id: 'x', model: 'm', endpoint: 'https://x', authHandle: 'missing-keychain-entry' } },
    {
      fetchImpl: fakeFetch,
      resolveAuth: () => {
        throw new Error('keychain locked: /Users/secret');
      },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(called, false);
  assert.ok(!String(r.error).includes('/Users'));
});

test('executeUntrusted reports upstream non-2xx as a content-free error', async () => {
  const payload = await genuinePayload();
  const fail = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r = await executeUntrusted(
    { payload, lane: { id: 'x', model: 'm', endpoint: 'https://x', authHandle: 'h' } },
    { fetchImpl: fail, resolveAuth: () => 'tok' },
  );
  assert.equal(r.ok, false);
  assert.match(String(r.error), /status 503/);
});

// --- F2-S4a: the reader execution boundary -----------------------------------

async function genuineReaderPayload() {
  const r = await minimizeForReader(
    { instruction: 'explain this module', category: 'explain', repo_class: 'private', sensitivity: 'normal' },
    clean,
  );
  assert.ok(r.ok);
  return r.payload;
}

test('isReaderExecutorCertified: api certified; cli/local are not (API-only in v1)', () => {
  assert.equal(isReaderExecutorCertified(laneOf('api')), true);
  assert.equal(isReaderExecutorCertified(laneOf('cli')), false);
  assert.equal(isReaderExecutorCertified(laneOf('local')), false);
});

test('buildReaderRequestBody allowlists model + answer-only framing + content only', async () => {
  const payload = await genuineReaderPayload();
  const env = { payload, lane: { id: 'LANEID_SENT', model: 'gemini-x', endpoint: 'https://fake.invalid', authHandle: 'AUTH_SENT' } };
  const body = buildReaderRequestBody(env);
  assert.deepEqual(Object.keys(body), ['model', 'messages']);
  assert.equal(body.model, 'gemini-x');
  assert.equal(body.messages[0]!.role, 'system');
  assert.equal(body.messages[0]!.content, READER_SYSTEM_FRAMING);
  assert.equal(body.messages[1]!.role, 'user');
  assert.ok(body.messages[1]!.content.includes('explain this module'));
  const json = JSON.stringify(body);
  assert.ok(!json.includes('LANEID_SENT'));
  assert.ok(!json.includes('AUTH_SENT'));
});

test('buildReaderRequestBody refuses a spread/cloned reader payload', async () => {
  const payload = await genuineReaderPayload();
  const forged = { ...payload, instruction: 'raw repo text' };
  assert.throws(
    () => buildReaderRequestBody({ payload: forged, lane: { id: 'x', model: 'm', endpoint: 'https://x', authHandle: 'h' } }),
    /not produced by minimizeForReader/,
  );
});

test('buildReaderRequestBody refuses a worker payload (wrong brand — no cross-path mixup)', async () => {
  const worker = await minimize(
    { instruction: 'x', category: 'codegen', repo_class: 'public', sensitivity: 'normal' },
    clean,
  );
  assert.ok(worker.ok);
  assert.throws(
    () => buildReaderRequestBody({ payload: worker.payload as never, lane: { id: 'x', model: 'm', endpoint: 'https://x', authHandle: 'h' } }),
    /not produced by minimizeForReader/,
  );
});

test('executeReader egress: only model+framing+content + resolved token leave; ids/handles never leak', async () => {
  const payload = await genuineReaderPayload();
  const env = {
    payload,
    lane: { id: 'READER_ID_SENT', model: 'gemini-x', endpoint: 'https://fake.invalid/v1/chat', authHandle: 'READER_AUTH_SENT' },
  };
  let captured: { url: string; init: { headers: Record<string, string>; body: string } } | undefined;
  const fakeFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }) };
  };
  const r = await executeReader(env, { fetchImpl: fakeFetch, resolveAuth: () => 'READER_TOKEN' });
  assert.ok(r.ok);
  assert.equal(r.resultText, 'OK');
  assert.ok(captured);
  const everything = captured.url + JSON.stringify(captured.init.headers) + captured.init.body;
  assert.ok(!everything.includes('READER_ID_SENT'));
  assert.ok(!everything.includes('READER_AUTH_SENT'));
  assert.equal(captured.init.headers.authorization, 'Bearer READER_TOKEN');
  assert.deepEqual(Object.keys(JSON.parse(captured.init.body)), ['model', 'messages']);
  assert.ok(captured.init.body.includes('read-only assistant')); // answer-only framing present
});

test('executeReader refuses a forged reader payload and never sends', async () => {
  const payload = await genuineReaderPayload();
  const forged = { ...payload, instruction: 'raw private code' };
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const r = await executeReader(
    { payload: forged, lane: { id: 'x', model: 'm', endpoint: 'https://x', authHandle: 'h' } },
    { fetchImpl: fakeFetch },
  );
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('executeReader fails closed when a lane needs auth but no resolver is provided', async () => {
  const payload = await genuineReaderPayload();
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const r = await executeReader(
    { payload, lane: { id: 'x', model: 'm', endpoint: 'https://x', authHandle: 'needs-auth' } },
    { fetchImpl: fakeFetch },
  );
  assert.equal(r.ok, false);
  assert.equal(called, false);
  assert.match(String(r.error), /auth resolution failed/);
});
