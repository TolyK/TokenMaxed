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
