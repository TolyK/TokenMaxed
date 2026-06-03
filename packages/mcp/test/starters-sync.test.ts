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

test('policy.starter.yaml matches config/policy.example.yaml', () => {
  const shipped = read(new URL('../policy.starter.yaml', import.meta.url));
  const canonical = read(new URL('../../../config/policy.example.yaml', import.meta.url));
  assert.equal(shipped, canonical, 'run: cp config/policy.example.yaml packages/mcp/policy.starter.yaml');
});
