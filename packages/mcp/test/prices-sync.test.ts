/**
 * Guard: the price seed shipped with @tokenmaxed/mcp (used as the module-relative
 * default and the source the plugin bundles) must stay in sync with the canonical
 * config/prices.seed.json. Pure file reads, no build. Compared as parsed JSON, so
 * formatting doesn't matter.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (url: URL) => JSON.parse(readFileSync(url, 'utf8'));

test('packages/mcp/prices.seed.json matches the canonical config/prices.seed.json', () => {
  const shipped = read(new URL('../prices.seed.json', import.meta.url));
  const canonical = read(new URL('../../../config/prices.seed.json', import.meta.url));
  assert.deepEqual(shipped, canonical, 'run: cp config/prices.seed.json packages/mcp/prices.seed.json');
});

test('packages/mcp/capability-snapshot.v1.json matches the canonical config/capability-snapshot.v1.json', () => {
  const shipped = read(new URL('../capability-snapshot.v1.json', import.meta.url));
  const canonical = read(new URL('../../../config/capability-snapshot.v1.json', import.meta.url));
  assert.deepEqual(shipped, canonical, 'run: cp config/capability-snapshot.v1.json packages/mcp/capability-snapshot.v1.json');
});
