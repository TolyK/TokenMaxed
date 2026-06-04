/**
 * Guard: the starter configs shipped with @tokenmaxed/mcp (used by
 * /tokenmaxed:setup to create ~/.tokenmaxed/*) must stay in sync with the
 * canonical config/*.example.yaml. Pure text reads, no build.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (url: URL) => readFileSync(url, 'utf8');

test('lanes.starter.yaml matches config/lanes.example.yaml', () => {
  const shipped = read(new URL('../lanes.starter.yaml', import.meta.url));
  const canonical = read(new URL('../../../config/lanes.example.yaml', import.meta.url));
  assert.equal(shipped, canonical, 'run: cp config/lanes.example.yaml packages/mcp/lanes.starter.yaml');
});

test('the PLUGIN lanes.starter.yaml also matches config/lanes.example.yaml', () => {
  // build.mjs copies this from the mcp starter; guard it so a stale plugin starter
  // can't ship an out-of-date default (e.g. an enabled Ollama after CONFIG-1).
  const shipped = read(new URL('../../plugin/lanes.starter.yaml', import.meta.url));
  const canonical = read(new URL('../../../config/lanes.example.yaml', import.meta.url));
  assert.equal(shipped, canonical, 'run: npm run build:plugin (copies lanes.starter.yaml into packages/plugin)');
});

test('policy.starter.yaml matches config/policy.example.yaml', () => {
  const shipped = read(new URL('../policy.starter.yaml', import.meta.url));
  const canonical = read(new URL('../../../config/policy.example.yaml', import.meta.url));
  assert.equal(shipped, canonical, 'run: cp config/policy.example.yaml packages/mcp/policy.starter.yaml');
});
