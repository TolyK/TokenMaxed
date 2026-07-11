/**
 * F2 — OpenCode adapter integrity: the committed bundles exist, the example
 * config launches the committed server WITH the host-identity environment, the
 * generated commands carry OpenCode tool names (never Claude-format names), and
 * the reference data ships. Pure file reads, no build.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const at = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string): string => readFileSync(at(rel), 'utf8');

test('committed bundles exist (server + in-process plugin + review child)', () => {
  assert.ok(existsSync(at('server/index.mjs')), 'server bundle must be committed');
  assert.ok(existsSync(at('plugin/tokenmaxed.js')), 'plugin bundle must be committed');
  assert.ok(existsSync(at('plugin/tokenmaxed-review.mjs')), 'review child must ship NEXT TO the plugin');
});

test('server + review-child bundles default host identity; plugin bundle must NOT mutate process.env', () => {
  // Child processes — the ??= default is correct there.
  assert.match(read('server/index.mjs'), /process\.env\.TOKENMAXED_HOST \?\?= 'opencode'/);
  assert.match(read('plugin/tokenmaxed-review.mjs'), /process\.env\.TOKENMAXED_HOST \?\?= 'opencode'/);
  // The plugin runs IN-PROCESS in OpenCode — an env-mutation banner would leak
  // the default into the whole host process (it threads the host explicitly).
  assert.doesNotMatch(read('plugin/tokenmaxed.js'), /process\.env\.TOKENMAXED_HOST \?\?=/);
});

test('the in-process plugin bundle contains no spawnSync (the review runs in the child)', () => {
  // The whole host-review path is spawnSync-based; bundling any of it into the
  // in-process plugin would freeze OpenCode's event loop for minutes.
  assert.doesNotMatch(read('plugin/tokenmaxed.js'), /spawnSync/);
  assert.match(read('plugin/tokenmaxed-review.mjs'), /spawnSync/); // …the child is where it lives
});

test('example config: local MCP server with TOKENMAXED_HOST=opencode environment', () => {
  const raw = read('opencode.example.jsonc').replace(/^\s*\/\/.*$/gm, ''); // strip line comments
  const cfg = JSON.parse(raw) as {
    mcp: Record<string, { type: string; command: string[]; environment?: Record<string, string> }>;
    plugin: string[];
    permission: Record<string, string>;
  };
  const server = cfg.mcp.tokenmaxed!;
  assert.equal(server.type, 'local');
  assert.equal(server.command[0], 'node');
  assert.match(server.command[1]!, /packages\/opencode-plugin\/server\/index\.mjs$/);
  // The host identity is REQUIRED — hosts:-scoped lanes fail closed without it.
  assert.equal(server.environment?.TOKENMAXED_HOST, 'opencode');
  assert.ok(cfg.plugin.some((p) => p.endsWith('plugin/tokenmaxed.js')));
  assert.equal(cfg.permission['tokenmaxed_*'], 'allow');
});

test('generated commands: OpenCode tool names + command refs, no Claude leftovers', () => {
  const files = readdirSync(at('command'));
  assert.ok(files.length >= 13, `expected ≥13 generated commands, got ${files.length}`);
  for (const f of files) {
    assert.match(f, /^tokenmaxed-[a-z-]+\.md$/, `${f}: command filename shape`);
    const md = read(`command/${f}`);
    assert.match(md, /^---\ndescription: \S/, `${f}: description frontmatter`);
    assert.doesNotMatch(md, /mcp__plugin_tokenmaxed/, `${f}: Claude tool-name format must be transformed`);
    assert.doesNotMatch(md, /\/tokenmaxed:[a-z]/, `${f}: /tokenmaxed:* refs must become /tokenmaxed-*`);
    assert.doesNotMatch(md, /disable-model-invocation/, `${f}: Claude-only frontmatter must be dropped`);
    // Host-language leftovers (body AND description — the description is
    // extracted separately in build.mjs, so it needs its own transform).
    for (const leftover of ['Claude stops delegating', 'in Claude Code', 'Claude offloads', 'Claude invokes', 'AskUserQuestion', 'start Claude Code']) {
      assert.ok(!md.includes(leftover), `${f}: untransformed host language: "${leftover}"`);
    }
  }
  // Spot-check a tool reference survived in OpenCode's server_tool shape.
  assert.match(read('command/tokenmaxed-status.md'), /tokenmaxed_router_status/);
});

test('reference data ships with the adapter (same set as the other hosts)', () => {
  for (const f of ['prices.seed.json', 'capability-snapshot.v1.json', 'lanes.starter.yaml', 'policy.starter.yaml']) {
    assert.ok(existsSync(at(f)), `${f} must be committed with the adapter`);
  }
});
