/**
 * Tests for the api-key → Claude Code CLI plugin suggestion helper. Pure (no I/O).
 * Verifies the provenance lookup and that only ENABLED api lanes for vendors with a
 * known CLI plugin produce a nudge (cli/local/blocked lanes never do).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Lane } from '@tokenmaxed/core';

import { cliPluginForProvenance, pluginSuggestionsFor } from '../src/cli-plugins.ts';

const apiBase: Lane = {
  id: 'x-api',
  kind: 'api',
  model: 'm',
  trust_mode: 'worker',
  costBasis: 'metered',
  provenance: 'xai',
  jurisdiction: 'US',
  endpoint: 'https://x',
  authHandle: 'XAI',
};

test('cliPluginForProvenance resolves known vendors (case-insensitive) and is undefined otherwise', () => {
  assert.equal(cliPluginForProvenance('xai')?.plugin, 'grok-plugin-cc');
  assert.equal(cliPluginForProvenance('GOOGLE')?.plugin, 'antigravity-plugin-cc');
  assert.equal(cliPluginForProvenance(' OpenAI ')?.cli, 'codex');
  assert.equal(cliPluginForProvenance('anthropic')?.vendor, 'Anthropic');
  // vendors with no CC CLI plugin ⇒ no suggestion to make.
  assert.equal(cliPluginForProvenance('zhipu'), undefined);
  assert.equal(cliPluginForProvenance('minimax'), undefined);
});

test('pluginSuggestionsFor nudges an ENABLED api lane whose vendor has a CLI plugin', () => {
  const out = pluginSuggestionsFor([apiBase]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    laneId: 'x-api',
    vendor: 'xAI',
    plugin: 'grok-plugin-cc',
    url: 'https://github.com/TolyK/grok-plugin-cc',
  });
});

test('pluginSuggestionsFor skips blocked api templates, cli/local lanes, unknown vendors, and keyless api lanes', () => {
  const lanes: Lane[] = [
    { ...apiBase, id: 'blocked-api', trust_mode: 'blocked' }, // not in use
    { ...apiBase, id: 'grok-cli', kind: 'cli', command: 'grok' }, // already on the subscription CLI
    { ...apiBase, id: 'glm-api', provenance: 'zhipu' }, // no CC CLI plugin
    { ...apiBase, id: 'ollama', kind: 'local', provenance: 'meta' },
    { ...apiBase, id: 'no-key-api', authHandle: undefined }, // not actually using a key
  ];
  assert.deepEqual(pluginSuggestionsFor(lanes), []);
});

test('pluginSuggestionsFor returns one nudge per enabled api lane, in config order', () => {
  const lanes: Lane[] = [
    { ...apiBase, id: 'sonnet-api', provenance: 'anthropic', authHandle: 'ANTHROPIC' },
    { ...apiBase, id: 'grok-api', provenance: 'xai' },
  ];
  assert.deepEqual(
    pluginSuggestionsFor(lanes).map((s) => s.laneId),
    ['sonnet-api', 'grok-api'],
  );
});
