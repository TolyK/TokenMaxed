/**
 * spawnPath — PATH augmentation for spawned CLI lanes. Ensures a provider CLI
 * installed alongside the running Node (nvm/global-npm, e.g. codex) resolves even
 * when the host/hook process has a stripped PATH (the codex-cli "failed to spawn"
 * class of bug). Pure (execPath + base injected), so unit-tested with no build.
 */

import assert from 'node:assert/strict';
import { delimiter } from 'node:path';
import { test } from 'node:test';

import { spawnPath } from '../src/config.ts';

test('spawnPath prepends the running Node bin dir so a sibling CLI resolves', () => {
  const out = spawnPath('/Users/x/.nvm/versions/node/v22/bin/node', `/usr/bin${delimiter}/bin`);
  const parts = out.split(delimiter);
  assert.equal(parts[0], '/Users/x/.nvm/versions/node/v22/bin', 'node bin dir comes first');
  assert.ok(parts.includes('/usr/bin') && parts.includes('/bin'), 'base PATH is preserved');
});

test('spawnPath does not duplicate the bin dir if already present', () => {
  const base = `/Users/x/.nvm/versions/node/v22/bin${delimiter}/usr/bin`;
  const out = spawnPath('/Users/x/.nvm/versions/node/v22/bin/node', base);
  const binDir = '/Users/x/.nvm/versions/node/v22/bin';
  assert.equal(out.split(delimiter).filter((p) => p === binDir).length, 1, 'no duplicate entry');
});

test('spawnPath tolerates an empty base PATH (returns just the bin dir)', () => {
  // Note: passing `undefined` would trigger the default param (process.env.PATH);
  // the genuinely-empty case is an empty string, which yields only the bin dir.
  assert.equal(spawnPath('/opt/node/bin/node', ''), '/opt/node/bin');
});
