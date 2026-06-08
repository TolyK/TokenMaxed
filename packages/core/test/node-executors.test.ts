import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  JsonlLedger,
  laneToUntrustedDTO,
  makeCliExecutor,
  makeOllamaExecutor,
  makeTrustedApiExecutor,
  makeTrustedExecutor,
  runAndRecord,
} from '../src/node.ts';
import { LaneFailure, isTransient } from '../src/failure.ts';
import type { PriceTable } from '../src/price.ts';
import type { Lane, RouteContext } from '../src/types.ts';

const TABLE: PriceTable = {
  schema_version: 1,
  frontier_model: 'claude-opus-4-7',
  models: {
    'claude-opus-4-7': { inputPer1M: 15, outputPer1M: 75 },
    'gpt-5.5': { inputPer1M: 10, outputPer1M: 30 },
    'llama3.1:8b': { inputPer1M: 0, outputPer1M: 0 },
  },
};

const codexCli: Lane = {
  id: 'codex-cli', kind: 'cli', model: 'gpt-5.5', trust_mode: 'full',
  costBasis: 'subscription', provenance: 'openai', jurisdiction: 'US',
  command: 'codex', args: ['exec'], capability: { bugfix: 0.9 },
};
const ollamaLane: Lane = {
  id: 'ollama', kind: 'local', model: 'llama3.1:8b', trust_mode: 'full',
  costBasis: 'local', provenance: 'meta', jurisdiction: 'US', capability: { docs: 0.7 },
};
const hostLane: Lane = {
  id: 'claude-native', kind: 'cli', model: 'claude-opus-4-7', trust_mode: 'full',
  costBasis: 'subscription', provenance: 'anthropic', jurisdiction: 'US', native: true, capability: { feature: 0.95 },
}; // explicit host lane ⇒ native

function tempLedger(): { dir: string; ledger: JsonlLedger } {
  const dir = mkdtempSync(join(tmpdir(), 'tmx-exec-'));
  return { dir, ledger: new JsonlLedger(join(dir, 'ledger.jsonl')) };
}

test('makeCliExecutor spawns the command with the instruction on stdin and returns stdout', async () => {
  let seen: { cmd: string; args: readonly string[]; input: string } | undefined;
  const exec = makeCliExecutor((cmd, args, opts) => {
    seen = { cmd, args, input: opts.input };
    return { status: 0, stdout: 'cli result' };
  });
  const r = await exec(codexCli, 'fix the bug');
  assert.equal(r.resultText, 'cli result');
  assert.equal(seen?.cmd, 'codex');
  assert.deepEqual(seen?.args, ['exec']);
  assert.equal(seen?.input, 'fix the bug');
});

test('makeCliExecutor throws on a non-zero exit (so runTask degrades)', async () => {
  const exec = makeCliExecutor(() => ({ status: 1, stdout: '' }));
  await assert.rejects(() => exec(codexCli, 'x'));
});

test('makeTrustedApiExecutor: a recovery retry with PARTIAL usage keeps the first call\'s billed spend + estimates the call that omitted usage', async () => {
  let calls = 0;
  const exec = makeTrustedApiExecutor({
    fetchImpl: async () => {
      calls++;
      // First call reports usage (incl. the hidden reasoning that burned the budget) but
      // is empty+length; the retry succeeds but OMITS usage (e.g. an OpenAI-compatible
      // proxy). The total must preserve the first call's 200 completion tokens AND count
      // the retry's output — never drop one or record only one as exact.
      if (calls === 1) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 200 } }) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'recovered' } }] }) }; // no usage field
    },
    resolveAuth: () => 'tok',
  });
  const apiLane: Lane = { id: 'mm', kind: 'api', model: 'MiniMax-M3', trust_mode: 'full', costBasis: 'metered', provenance: 'minimax', jurisdiction: 'CN', endpoint: 'https://mm/v1/chat', authHandle: 'h', capability: { codegen: 0.8 } };
  const r = await exec(apiLane, 'do it');
  assert.equal(r.resultText, 'recovered');
  assert.ok(r.reported); // a complete best-effort total (not dropped, not partial-as-exact)
  assert.ok(r.reported!.tokens_in! >= 100); // first call's input preserved
  assert.ok(r.reported!.tokens_out! > 200); // first call's billed reasoning (200) preserved + retry output estimated on top
  assert.equal(r.reportedEstimated, true); // flagged non-exact (one call's usage was estimated) → logged tokens_estimated:true
});

test('makeTrustedApiExecutor: a recovery retry reporting only ONE usage side is treated as estimated (not exact)', async () => {
  let calls = 0;
  const exec = makeTrustedApiExecutor({
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 200 } }) };
      // Retry succeeds but reports ONLY prompt_tokens (partial RawUsage) — the missing
      // completion side must be estimated, and the total flagged non-exact.
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'recovered' } }], usage: { prompt_tokens: 5 } }) };
    },
    resolveAuth: () => 'tok',
  });
  const apiLane: Lane = { id: 'mm', kind: 'api', model: 'MiniMax-M3', trust_mode: 'full', costBasis: 'metered', provenance: 'minimax', jurisdiction: 'CN', endpoint: 'https://mm/v1/chat', authHandle: 'h', capability: { codegen: 0.8 } };
  const r = await exec(apiLane, 'do it');
  assert.equal(r.resultText, 'recovered');
  assert.equal(r.reported!.tokens_in, 105); // 100 (first) + 5 (retry, reported)
  assert.ok(r.reported!.tokens_out! > 200); // 200 (first) + estimated retry completion (the missing side)
  assert.equal(r.reportedEstimated, true); // a partial side was estimated ⇒ non-exact
});

test('makeTrustedApiExecutor: a recovery retry that 429s KEEPS rate_limited (so the lane cools down)', async () => {
  let calls = 0;
  const exec = makeTrustedApiExecutor({
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 50, completion_tokens: 60 } }) };
      return { ok: false, status: 429, json: async () => ({}) }; // genuine capacity signal on the retry
    },
    resolveAuth: () => 'tok',
  });
  const apiLane: Lane = { id: 'mm', kind: 'api', model: 'MiniMax-M3', trust_mode: 'full', costBasis: 'metered', provenance: 'minimax', jurisdiction: 'CN', endpoint: 'https://mm/v1/chat', authHandle: 'h', capability: { codegen: 0.8 } };
  await assert.rejects(() => exec(apiLane, 'do it'), (e: unknown) => {
    assert.ok(e instanceof LaneFailure);
    assert.equal(e.failureKind, 'rate_limited'); // real capacity signal preserved (cooldown), NOT flattened
    assert.deepEqual(e.reported, { tokens_in: 50, tokens_out: 60 }); // first-call spend still preserved
    return true;
  });
});

test('makeTrustedApiExecutor: the FIRST call sends NO max_tokens (no regression for lanes whose model rejects it)', async () => {
  let firstBody: string | undefined;
  const exec = makeTrustedApiExecutor({
    fetchImpl: async (_url, init) => { firstBody ??= init.body; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }; },
    resolveAuth: () => 'tok',
  });
  const apiLane: Lane = { id: 'k', kind: 'api', model: 'some-model', trust_mode: 'full', costBasis: 'metered', provenance: 'x', jurisdiction: 'US', endpoint: 'https://k/v1/chat', authHandle: 'h', capability: { codegen: 0.8 } };
  await exec(apiLane, 'do it');
  assert.deepEqual(Object.keys(JSON.parse(firstBody!)), ['model', 'messages']); // no max_tokens on the normal path
});

test('makeTrustedApiExecutor: empty content + finish_reason length triggers ONE retry with a higher max_tokens', async () => {
  const bodies: string[] = [];
  const exec = makeTrustedApiExecutor({
    fetchImpl: async (_url, init) => {
      bodies.push(init.body);
      // First call: the reasoning model spent the whole budget on reasoning ⇒ empty + length,
      // BUT it still consumed (and reported) tokens — that spend must not be lost.
      if (bodies.length === 1) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 200 } }) };
      }
      // Retry call: returns real content + its own usage.
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'recovered' } }], usage: { prompt_tokens: 4, completion_tokens: 9 } }) };
    },
    resolveAuth: () => 'tok',
  });
  const apiLane: Lane = { id: 'mm', kind: 'api', model: 'MiniMax-M3', trust_mode: 'full', costBasis: 'subscription', provenance: 'minimax', jurisdiction: 'CN', endpoint: 'https://mm/v1/chat', authHandle: 'h', capability: { codegen: 0.8 } };
  const r = await exec(apiLane, 'do it');
  assert.equal(r.resultText, 'recovered');
  assert.equal(bodies.length, 2); // retried exactly once
  assert.equal(JSON.parse(bodies[0]!).max_tokens, undefined); // first call sends NO cap (no regression for other lanes)
  assert.equal(JSON.parse(bodies[1]!).max_tokens, 32_000); // cap applied ONLY on the recovery retry
  // Usage ACCUMULATES across both calls (the first call's spend is never discarded).
  assert.deepEqual(r.reported, { tokens_in: 104, tokens_out: 209 });
});

test('makeTrustedApiExecutor: a failed retry still preserves the first call\'s reported usage (no ZERO_USAGE)', async () => {
  let calls = 0;
  const exec = makeTrustedApiExecutor({
    fetchImpl: async () => {
      calls++;
      // First call billed tokens but returned empty+length; the retry then 400s
      // (the model rejects our injected max_tokens) — the case that must NOT become a
      // permanent bad_request that blocks fallback.
      if (calls === 1) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 200 } }) };
      return { ok: false, status: 400, json: async () => ({}) };
    },
    resolveAuth: () => 'tok',
  });
  const apiLane: Lane = { id: 'mm', kind: 'api', model: 'MiniMax-M3', trust_mode: 'full', costBasis: 'subscription', provenance: 'minimax', jurisdiction: 'CN', endpoint: 'https://mm/v1/chat', authHandle: 'h', capability: { codegen: 0.8 } };
  await assert.rejects(() => exec(apiLane, 'do it'), (e: unknown) => {
    assert.ok(e instanceof LaneFailure);
    // The retry is best-effort recovery; its failure is TRANSIENT (so routing can fall
    // back) rather than a permanent classification, and never permanent bad_request.
    assert.equal(e.failureKind, 'provider_error');
    assert.ok(isTransient(e.failureKind)); // routeable — does not block fallback
    assert.deepEqual(e.reported, { tokens_in: 100, tokens_out: 200 }); // first-call spend preserved
    return true;
  });
});

test('makeTrustedApiExecutor: non-empty content does NOT retry (only empty+length does)', async () => {
  let calls = 0;
  const exec = makeTrustedApiExecutor({
    fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'fine' }, finish_reason: 'length' }] }) }; },
    resolveAuth: () => 'tok',
  });
  const apiLane: Lane = { id: 'mm', kind: 'api', model: 'MiniMax-M3', trust_mode: 'full', costBasis: 'subscription', provenance: 'minimax', jurisdiction: 'CN', endpoint: 'https://mm/v1/chat', authHandle: 'h', capability: { codegen: 0.8 } };
  const r = await exec(apiLane, 'do it');
  assert.equal(r.resultText, 'fine');
  assert.equal(calls, 1); // content present ⇒ no retry even though finish_reason was length
});

test('makeCliExecutor substitutes the {model} placeholder with the resolved lane model', async () => {
  // MODEL-FRESHNESS: a cli lane uses `--model {model}` instead of a hard-pinned id, so
  // the spawn always runs the lane's current (price-table-resolved) model.
  let seen: readonly string[] = [];
  const exec = makeCliExecutor((_cmd, args) => {
    seen = args;
    return { status: 0, stdout: 'ok' };
  });
  const sonnet: Lane = {
    id: 'claude-sonnet', kind: 'cli', model: 'claude-sonnet-4-6', trust_mode: 'full',
    costBasis: 'subscription', provenance: 'anthropic', jurisdiction: 'US',
    command: 'claude', args: ['-p', '--model', '{model}'], capability: { codegen: 0.85 },
  };
  await exec(sonnet, 'do it');
  assert.deepEqual(seen, ['-p', '--model', 'claude-sonnet-4-6']); // {model} ⇒ lane.model
});

test('makeOllamaExecutor posts to /api/generate and maps eval counts to usage', async () => {
  let url: string | undefined;
  const exec = makeOllamaExecutor(async (u) => {
    url = u;
    return { ok: true, status: 200, json: async () => ({ response: 'hi', prompt_eval_count: 12, eval_count: 7 }) };
  });
  const r = await exec(ollamaLane, 'say hi');
  assert.match(url ?? '', /\/api\/generate$/);
  assert.equal(r.resultText, 'hi');
  assert.deepEqual(r.reported, { tokens_in: 12, tokens_out: 7 });
});

test('makeCliExecutor forwards attachments in the stdin prompt', async () => {
  let input = '';
  const exec = makeCliExecutor((_cmd, _args, opts) => {
    input = opts.input;
    return { status: 0, stdout: 'ok' };
  });
  await exec(codexCli, 'do it', [{ content: 'ATTACHED_CONTEXT' }]);
  assert.match(input, /do it/);
  assert.match(input, /ATTACHED_CONTEXT/); // attachment is included, not dropped
});

test('makeTrustedApiExecutor sends full content + resolved auth; maps usage', async () => {
  let body = '';
  const exec = makeTrustedApiExecutor({
    fetchImpl: async (_url, init) => {
      body = init.body;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'api result' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }) };
    },
    resolveAuth: () => 'TOK',
  });
  const apiLane: Lane = { id: 'azure', kind: 'api', model: 'gpt-x', trust_mode: 'full', costBasis: 'metered', provenance: 'openai', jurisdiction: 'US', endpoint: 'https://azure/v1/chat', authHandle: 'h', capability: { feature: 0.9 } };
  const r = await exec(apiLane, 'do it', [{ content: 'CTX' }]);
  assert.equal(r.resultText, 'api result');
  assert.deepEqual(r.reported, { tokens_in: 5, tokens_out: 3 });
  assert.match(body, /CTX/); // full content (trusted lane, no minimization)
});

test('makeTrustedExecutor dispatches local→ollama, cli+command→cli, api+endpoint→api, else→native', async () => {
  const exec = makeTrustedExecutor({
    cli: async () => ({ resultText: 'from cli' }),
    ollama: async () => ({ resultText: 'from ollama' }),
    api: async () => ({ resultText: 'from api' }),
  });
  const apiLane: Lane = { id: 'azure', kind: 'api', model: 'm', trust_mode: 'full', costBasis: 'metered', provenance: 'openai', jurisdiction: 'US', endpoint: 'https://azure' };
  assert.equal((await exec(ollamaLane, 'x')).resultText, 'from ollama');
  assert.equal((await exec(codexCli, 'x')).resultText, 'from cli');
  assert.equal((await exec(apiLane, 'x')).resultText, 'from api'); // full API lane executes, not native
  assert.equal((await exec(hostLane, 'x')).native, true); // explicit native lane ⇒ native
  // A misconfigured lane (cli with no command, not native) THROWS rather than silently going native.
  const misconfigured: Lane = { id: 'broken', kind: 'cli', model: 'm', trust_mode: 'full', costBasis: 'subscription', provenance: 'x', jurisdiction: 'US' };
  await assert.rejects(() => exec(misconfigured, 'x'), /no executor configured/);
});

test('laneToUntrustedDTO requires an endpoint', () => {
  const worker: Lane = { id: 'w', kind: 'api', model: 'm', trust_mode: 'worker', costBasis: 'metered', provenance: 'x', jurisdiction: 'US', endpoint: 'https://w', authHandle: 'h' };
  assert.deepEqual(laneToUntrustedDTO(worker), { id: 'w', model: 'm', endpoint: 'https://w', authHandle: 'h' });
  assert.throws(() => laneToUntrustedDTO({ ...worker, endpoint: undefined }), /no endpoint/);
});

test('runAndRecord runs a trusted lane and appends a task event to the ledger', async () => {
  const { dir, ledger } = tempLedger();
  try {
    const ctx: RouteContext = { lanes: [codexCli] };
    const r = await runAndRecord({ category: 'bugfix', instruction: 'fix it' }, ctx, {}, {
      ledger,
      priceTable: TABLE,
      executeTrusted: makeTrustedExecutor({ cli: async () => ({ resultText: 'fixed', reported: { tokens_in: 100, tokens_out: 20 } }) }),
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.laneId, 'codex-cli');
    const events = ledger.readAll();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_type, 'task');
    if (events[0]?.event_type === 'task') {
      assert.equal(events[0].laneId, 'codex-cli');
      assert.equal(events[0].tokens_in, 100);
      assert.equal(events[0].status, 'ok');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAndRecord degrades to native and records nothing extra when the host lane is chosen', async () => {
  const { dir, ledger } = tempLedger();
  try {
    const ctx: RouteContext = { lanes: [hostLane] };
    const r = await runAndRecord({ category: 'feature', instruction: 'do it' }, ctx, {}, { ledger, priceTable: TABLE });
    assert.equal(r.native, true);
    assert.equal(ledger.readAll().length, 0); // native isn't recorded
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fetch timeout tests — ensure a stalled fetch is hard-bounded by wrapWithFetchTimeout
// ---------------------------------------------------------------------------

const apiLaneForTimeout: Lane = {
  id: 'api-timeout', kind: 'api', model: 'gpt-x', trust_mode: 'full',
  costBasis: 'metered', provenance: 'openai', jurisdiction: 'US',
  endpoint: 'https://api.example.com/v1/chat', capability: { feature: 0.9 },
};

test('makeTrustedApiExecutor: a hanging fetch resolves to LaneFailure(timeout) within fetchTimeoutMs', async () => {
  let capturedSignal: AbortSignal | undefined;
  // fetchImpl that never resolves — simulates a stalled connection.
  const hangingFetch = (_url: string, init: { signal?: AbortSignal }): Promise<never> => {
    capturedSignal = init.signal;
    return new Promise<never>(() => { /* never resolves */ });
  };
  const exec = makeTrustedApiExecutor({ fetchImpl: hangingFetch as typeof hangingFetch & Parameters<typeof makeTrustedApiExecutor>[0], fetchTimeoutMs: 100 });
  const start = Date.now();
  await assert.rejects(
    () => exec(apiLaneForTimeout, 'test'),
    (err: unknown) => {
      assert.ok(err instanceof LaneFailure, 'should be a LaneFailure');
      assert.equal((err as LaneFailure).failureKind, 'timeout');
      return true;
    },
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `should reject quickly (elapsed: ${elapsed}ms)`);
  // AbortSignal should have been aborted after the timeout.
  assert.ok(capturedSignal?.aborted === true, 'AbortSignal should be aborted after timeout');
});

const ollamaLaneForTimeout: Lane = {
  id: 'ollama-timeout', kind: 'local', model: 'llama3.1:8b', trust_mode: 'full',
  costBasis: 'local', provenance: 'meta', jurisdiction: 'US', capability: { docs: 0.7 },
};

test('makeOllamaExecutor: a hanging fetch resolves to LaneFailure(timeout) within fetchTimeoutMs', async () => {
  let capturedSignal: AbortSignal | undefined;
  const hangingFetch = (_url: string, init: { signal?: AbortSignal }): Promise<never> => {
    capturedSignal = init.signal;
    return new Promise<never>(() => { /* never resolves */ });
  };
  const exec = makeOllamaExecutor(hangingFetch as Parameters<typeof makeOllamaExecutor>[0], { fetchTimeoutMs: 100 });
  const start = Date.now();
  await assert.rejects(
    () => exec(ollamaLaneForTimeout, 'test'),
    (err: unknown) => {
      assert.ok(err instanceof LaneFailure, 'should be a LaneFailure');
      assert.equal((err as LaneFailure).failureKind, 'timeout');
      return true;
    },
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `should reject quickly (elapsed: ${elapsed}ms)`);
  assert.ok(capturedSignal?.aborted === true, 'AbortSignal should be aborted after timeout');
});

test('makeTrustedApiExecutor: a fetch that hangs on res.json() is also bounded', async () => {
  // The fetch returns headers quickly but the body never arrives.
  const exec = makeTrustedApiExecutor({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: (): Promise<never> => new Promise(() => { /* never resolves */ }),
    }),
    fetchTimeoutMs: 100,
  });
  const start = Date.now();
  await assert.rejects(
    () => exec(apiLaneForTimeout, 'test'),
    (err: unknown) => {
      assert.ok(err instanceof LaneFailure);
      assert.equal((err as LaneFailure).failureKind, 'timeout');
      return true;
    },
  );
  assert.ok(Date.now() - start < 500);
});

test('makeTrustedApiExecutor: HTTP non-ok still maps to typed LaneFailure (not swallowed by timeout wrapper)', async () => {
  const exec = makeTrustedApiExecutor({
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    fetchTimeoutMs: 5_000,
  });
  await assert.rejects(
    () => exec(apiLaneForTimeout, 'test'),
    (err: unknown) => {
      assert.ok(err instanceof LaneFailure);
      assert.equal((err as LaneFailure).failureKind, 'rate_limited');
      return true;
    },
  );
});
