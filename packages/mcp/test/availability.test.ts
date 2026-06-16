/**
 * Tests for the lane availability probe (host I/O made injectable). Verifies the
 * per-kind rules: native always available; cli ⇒ command on PATH; local ⇒ server
 * reachable; api ⇒ BYOK key present.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { availableLaneIds, commandOnPath, isLaneAvailable, makeAvailabilityProbe } from '../src/availability.ts';
import type { Lane } from '@tokenmaxed/core';

const base: Lane = {
  id: 'x',
  kind: 'cli',
  model: 'm',
  trust_mode: 'full',
  costBasis: 'subscription',
  provenance: 'openai',
  jurisdiction: 'US',
};

/** A temp dir with one executable "tool", returned as a PATH-style string. */
function pathWithTool(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tm-avail-'));
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  return dir;
}

const noAuth = () => '';

test('commandOnPath finds a bare command on PATH and rejects a missing one', () => {
  const dir = pathWithTool('mytool');
  assert.equal(commandOnPath('mytool', dir), true);
  assert.equal(commandOnPath('definitely-not-here-zzz', dir), false);
  assert.equal(commandOnPath('', dir), false);
});

test('commandOnPath treats a slashed command as a literal path', () => {
  const dir = pathWithTool('tool2');
  assert.equal(commandOnPath(join(dir, 'tool2'), '/nonexistent'), true);
  assert.equal(commandOnPath('/no/such/binary', dir), false);
});

test('commandOnPath rejects a non-executable file on PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-avail-'));
  const file = join(dir, 'notexec');
  writeFileSync(file, 'data');
  chmodSync(file, 0o644); // present but NOT executable ⇒ not runnable
  assert.equal(commandOnPath('notexec', dir), false);
});

test('commandOnPath rejects a directory that shares the command name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-avail-'));
  mkdirSync(join(dir, 'codex')); // a dir named like the command is not a runnable command
  assert.equal(commandOnPath('codex', dir), false);
});

test('native lane is always available', async () => {
  const lane: Lane = { ...base, id: 'native', native: true };
  assert.equal(await isLaneAvailable(lane, { path: '', resolveAuth: noAuth }), true);
});

test('cli lane available iff its command resolves on PATH', async () => {
  const dir = pathWithTool('codex');
  const lane: Lane = { ...base, kind: 'cli', command: 'codex' };
  assert.equal(await isLaneAvailable(lane, { path: dir, resolveAuth: noAuth }), true);
  assert.equal(await isLaneAvailable(lane, { path: '/nowhere', resolveAuth: noAuth }), false);
});

test('api lane available iff the BYOK key is present', async () => {
  const lane: Lane = { ...base, kind: 'api', authHandle: 'ZHIPU', endpoint: 'https://x' };
  assert.equal(await isLaneAvailable(lane, { path: '', resolveAuth: (h) => (h === 'ZHIPU' ? 'sk-123' : '') }), true);
  assert.equal(await isLaneAvailable(lane, { path: '', resolveAuth: noAuth }), false);
});

test('local lane available iff the server answers ok', async () => {
  const lane: Lane = { ...base, kind: 'local', endpoint: 'http://localhost:11434' };
  const up = { path: '', resolveAuth: noAuth, fetchImpl: async () => ({ ok: true }) };
  const down = {
    path: '',
    resolveAuth: noAuth,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  };
  assert.equal(await isLaneAvailable(lane, up), true);
  assert.equal(await isLaneAvailable(lane, down), false);
});

test('availableLaneIds returns only the runnable ids', async () => {
  const dir = pathWithTool('codex');
  const lanes: Lane[] = [
    { ...base, id: 'host', native: true },
    { ...base, id: 'codex', kind: 'cli', command: 'codex' },
    { ...base, id: 'ghost', kind: 'cli', command: 'not-installed-zzz' },
    { ...base, id: 'glm', kind: 'api', authHandle: 'ZHIPU', endpoint: 'https://x' },
  ];
  const ids = await availableLaneIds(lanes, { path: dir, resolveAuth: (h) => (h === 'ZHIPU' ? 'k' : '') });
  assert.deepEqual(ids.sort(), ['codex', 'glm', 'host']);
});

test('a node-runner CLI lane is available only when its script arg exists (companion path / placeholder guard)', async () => {
  const nodeDir = dirname(process.execPath); // `node` resolves here
  const dir = mkdtempSync(join(tmpdir(), 'tm-companion-'));
  const script = join(dir, 'agy-companion.mjs');
  writeFileSync(script, '// companion\n');
  const path = `${nodeDir}:${dir}`;
  const present: Lane = { ...base, id: 'agy', kind: 'cli', command: 'node', args: [script, 'ask', '--stdin'] };
  const missing: Lane = { ...base, id: 'agy-missing', kind: 'cli', command: 'node', args: [join(dir, 'gone.mjs'), 'ask'] };
  const placeholder: Lane = { ...base, id: 'agy-tmpl', kind: 'cli', command: 'node', args: ['<ABSOLUTE-PATH-TO>/agy-companion.mjs', 'ask', '--stdin'] };
  assert.equal(await isLaneAvailable(present, { path, resolveAuth: noAuth }), true);
  assert.equal(await isLaneAvailable(missing, { path, resolveAuth: noAuth }), false);
  assert.equal(await isLaneAvailable(placeholder, { path, resolveAuth: noAuth }), false); // template placeholder ⇒ unavailable
});

test('makeAvailabilityProbe finds a CLI installed beside Node even when the host PATH omits it', async () => {
  // Regression: under a stripped host/hook PATH a bare-command CLI lane was marked
  // unavailable, so it never reached the spawn that augments PATH. The probe must
  // use the SAME augmented PATH — `node` always lives in dirname(process.execPath).
  const probe = makeAvailabilityProbe({ PATH: '' } as NodeJS.ProcessEnv);
  const lane: Lane = { ...base, id: 'beside-node', kind: 'cli', command: 'node' };
  assert.deepEqual(await probe([lane]), ['beside-node'], `node should resolve via ${dirname(process.execPath)}`);
});
