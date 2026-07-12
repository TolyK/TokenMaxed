/**
 * D — share-flow INTEGRATION: the built CLI end-to-end. Dry-run sends nothing;
 * --yes without an endpoint refuses with exit 1; --yes POSTs the EXACT
 * previewed bytes to a local fixture server, exits 0, and records the
 * revision; the committed web catalog stays a superset of the price table.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { SCHEMA_VERSION, serializeEvent } from '@tokenmaxed/core';
import type { LedgerEvent, OutcomeEvent, TaskEvent } from '@tokenmaxed/core';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/** Async spawn (the fixture server lives in THIS process — spawnSync would
 * block the event loop and deadlock the child against its own server). */
function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

let seq = 0;
function taskEvent(ts: string): TaskEvent {
  return {
    event_type: 'task', schema_version: SCHEMA_VERSION, id: `t-${seq}`, seq: seq++, ts,
    task_id: `task-${seq}`, attempt: 0, category: 'bugfix', laneId: 'codex', model: 'gpt-5.5',
    trust_mode: 'full', provenance: 'openai', status: 'ok', tokens_in: 100, tokens_out: 50,
    tokens_estimated: false, actual_cost: 0, frontier_cost: 1, metered_spent: 0,
    frontier_avoided: 1, metered_avoided: 1, policy_verdict: 'allow',
  };
}
function outcomeEvent(ts: string): OutcomeEvent {
  return {
    event_type: 'outcome', schema_version: SCHEMA_VERSION, id: `o-${seq}`, seq: seq++, ts,
    subject_id: 't-0', subject_type: 'router_task', task_id: 'task-1', review_id: 'r-1', attempt: 0,
    category: 'bugfix', subject_lane_id: 'codex', subject_provenance: 'openai',
    subject_model: 'gpt-5.5', subject_model_resolved: 'gpt-5.5', reviewer_lane_id: 'claude-native',
    reviewer_model: 'claude-opus-4-7', reviewer_trust_mode: 'full', reviewer_provenance: 'anthropic',
    verdict: 'pass', voter: 'reviewer_model', policy_verdict: 'allow',
  };
}

function setupDir(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-share-cli-'));
  const nowIso = new Date().toISOString(); // inside the current ISO week by construction
  const events: LedgerEvent[] = [taskEvent(nowIso), outcomeEvent(nowIso)];
  writeFileSync(join(dir, 'ledger.jsonl'), events.map((e) => serializeEvent(e)).join('\n') + '\n', 'utf8');
  return {
    dir,
    env: {
      ...process.env,
      TOKENMAXED_CONTRIBUTOR: join(dir, 'contributor.json'),
      TOKENMAXED_SHARE_URL: '', // explicit: not configured (overridden per test)
    },
  };
}

test('share (dry-run): prints consent + exact payload, creates the identity, sends nothing', () => {
  const { dir, env } = setupDir();
  try {
    const res = spawnSync(process.execPath, [CLI, 'share', '--ledger', join(dir, 'ledger.jsonl')], {
      encoding: 'utf8', env, timeout: 30_000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /never see your code or your prompts/i);
    assert.match(res.stdout, /EXACT payload/);
    assert.match(res.stdout, /"contributor_id"/);
    assert.match(res.stdout, /Nothing was sent/);
    const state = JSON.parse(readFileSync(join(dir, 'contributor.json'), 'utf8')) as { contributor_id: string; revisions: Record<string, number> };
    assert.match(state.contributor_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(state.revisions, {}); // dry-run records nothing
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('share --yes without an endpoint refuses with exit 1 (not launched yet)', () => {
  const { dir, env } = setupDir();
  try {
    const res = spawnSync(process.execPath, [CLI, 'share', '--yes', '--ledger', join(dir, 'ledger.jsonl')], {
      encoding: 'utf8', env, timeout: 30_000,
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not launched yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('share --yes POSTs the exact previewed bytes, exits 0, and records the revision', async () => {
  const { dir, env } = setupDir();
  const received: Array<{ url: string; body: string; contentType: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString('utf8')));
    req.on('end', () => {
      received.push({ url: req.url ?? '', body, contentType: String(req.headers['content-type']) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    // Dry-run first: capture the previewed payload bytes.
    const preview = spawnSync(process.execPath, [CLI, 'share', '--ledger', join(dir, 'ledger.jsonl')], {
      encoding: 'utf8', env, timeout: 30_000,
    });
    const previewed = preview.stdout.split('EXACT payload (what --yes would send — nothing more):\n')[1]!.split('\n')[0]!;

    const yes = await run(['share', '--yes', '--ledger', join(dir, 'ledger.jsonl')], {
      ...env,
      TOKENMAXED_SHARE_URL: `http://127.0.0.1:${port}/api/submit`,
    });
    assert.equal(yes.status, 0, yes.stderr);
    assert.match(yes.stdout, /uploaded .* revision 1/);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.url, '/api/submit');
    assert.equal(received[0]!.contentType, 'application/json');
    assert.equal(received[0]!.body, previewed); // the EXACT previewed bytes (same week, no new events)
    const state = JSON.parse(readFileSync(join(dir, 'contributor.json'), 'utf8')) as { revisions: Record<string, number> };
    assert.deepEqual(Object.values(state.revisions), [1]); // revision recorded on success
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('share --yes exits 1 when the server rejects (and records NO revision)', async () => {
  const { dir, env } = setupDir();
  const server = createServer((_req, res) => {
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end('{"ok":false,"reason":"unknown model"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await run(['share', '--yes', '--ledger', join(dir, 'ledger.jsonl')], {
      ...env,
      TOKENMAXED_SHARE_URL: `http://127.0.0.1:${port}/api/submit`,
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /422/);
    const state = JSON.parse(readFileSync(join(dir, 'contributor.json'), 'utf8')) as { revisions: Record<string, number> };
    assert.deepEqual(state.revisions, {}); // failure records nothing
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed web catalog is reproducible and a superset of the price table', () => {
  const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('../../../web/data/known-models.json', import.meta.url)), 'utf8')) as { models: string[] };
  const prices = JSON.parse(readFileSync(fileURLToPath(new URL('../../../config/prices.seed.json', import.meta.url)), 'utf8')) as { models: Record<string, unknown> };
  const set = new Set(catalog.models);
  for (const id of Object.keys(prices.models)) assert.ok(set.has(id), `catalog missing price-table model ${id} — run node web/generate-catalog.mjs`);
  // Subscription lane labels (not priced) must be present too.
  for (const label of ['grok-code-fast-1', 'gemini-3-pro']) assert.ok(set.has(label), `catalog missing lane label ${label}`);
});
