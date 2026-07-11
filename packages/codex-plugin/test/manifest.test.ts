/**
 * E — Codex CLI plugin integrity: the manifest references real files, the
 * bundled MCP config launches the committed server, hooks.json wires the three
 * committed hook bundles with ${PLUGIN_ROOT} paths, the generated skills carry
 * Codex frontmatter + namespaced tool names (never Claude-format names), and
 * the marketplace entry points at this package. Pure file reads, no build.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const at = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string): string => readFileSync(at(rel), 'utf8');
const json = (rel: string): Record<string, unknown> => JSON.parse(read(rel));

test('plugin.json: required fields + every referenced path exists', () => {
  const m = json('.codex-plugin/plugin.json');
  assert.equal(m.name, 'tokenmaxed');
  assert.match(m.version as string, /^\d+\.\d+\.\d+$/);
  assert.ok((m.description as string).length > 0);
  for (const key of ['skills', 'mcpServers', 'hooks'] as const) {
    const rel = (m[key] as string).replace(/^\.\//, '');
    assert.ok(existsSync(at(rel)), `${key} → ${rel} must exist`);
  }
});

test('.mcp.json launches the committed server bundle via ${PLUGIN_ROOT}', () => {
  const m = json('.mcp.json') as Record<string, { command: string; args: string[] }>;
  const server = m.tokenmaxed;
  assert.ok(server, '.mcp.json must define the tokenmaxed server');
  assert.equal(server!.command, 'node');
  assert.deepEqual(server!.args, ['${PLUGIN_ROOT}/server/index.mjs']);
  assert.ok(existsSync(at('server/index.mjs')), 'committed server bundle must exist');
});

test('hooks.json: three events, ${PLUGIN_ROOT} commands, committed bundles, delegate matcher namespaced', () => {
  const h = json('hooks/hooks.json') as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>> };
  assert.deepEqual(Object.keys(h.hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop']);
  for (const entries of Object.values(h.hooks)) {
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        assert.equal(hook.type, 'command');
        const m = /\$\{PLUGIN_ROOT\}\/(hooks\/[a-z]+\.mjs)/.exec(hook.command);
        assert.ok(m, `command must reference \${PLUGIN_ROOT}/hooks/*.mjs: ${hook.command}`);
        assert.ok(existsSync(at(m![1]!)), `${m![1]} must be committed`);
      }
    }
  }
  // The routing gate matches the CODEX-namespaced tool name, not Claude's.
  assert.equal(h.hooks.PreToolUse![0]!.matcher, 'tokenmaxed:router_delegate');
});

test('generated skills: Codex frontmatter (name+description), namespaced tools, no Claude leftovers', () => {
  const dirs = readdirSync(at('skills'));
  assert.ok(dirs.length >= 13, `expected ≥13 generated skills, got ${dirs.length}`);
  for (const dir of dirs) {
    const md = read(`skills/${dir}/SKILL.md`);
    assert.match(md, new RegExp(`^---\\nname: ${dir}\\n`), `${dir}: name frontmatter`);
    assert.match(md, /\ndescription:\s*\S/, `${dir}: description frontmatter`);
    assert.doesNotMatch(md, /mcp__plugin_tokenmaxed/, `${dir}: Claude tool-name format must be transformed`);
    assert.doesNotMatch(md, /disable-model-invocation/, `${dir}: Claude-only frontmatter must be dropped`);
    assert.doesNotMatch(md, /\/tokenmaxed:[a-z]/, `${dir}: /tokenmaxed:* refs must become $tokenmaxed-*`);
  }
  // Spot-check a tool reference survived the transform in the expected shape.
  assert.match(read('skills/tokenmaxed-status/SKILL.md'), /tokenmaxed:router_status/);
});

test('reference data ships with the plugin (same set as the Claude plugin)', () => {
  for (const f of ['prices.seed.json', 'capability-snapshot.v1.json', 'lanes.starter.yaml', 'policy.starter.yaml']) {
    assert.ok(existsSync(at(f)), `${f} must be committed with the plugin`);
  }
});

test('marketplace.json points this repo at packages/codex-plugin', () => {
  const m = JSON.parse(readFileSync(fileURLToPath(new URL('../../../.agents/plugins/marketplace.json', import.meta.url)), 'utf8'));
  const entry = m.plugins[0];
  assert.equal(entry.name, 'tokenmaxed');
  assert.equal(entry.source.path, './packages/codex-plugin');
  assert.equal(entry.source.source, 'git-subdir');
});

test('sessionstart bundle emits the JSON envelope (the SessionStart contract on BOTH hosts)', () => {
  // Codex 0.144 parses SessionStart stdout as JSON (SessionStartCommandOutputWire):
  // hookSpecificOutput.additionalContext (+ optional systemMessage) — the same
  // shape the Claude hook already emits, so the bundles share one source.
  const bundle = read('hooks/sessionstart.mjs');
  assert.match(bundle, /hookSpecificOutput/);
  assert.match(bundle, /additionalContext/);
});

test('stop bundle is the CODEX dialect entry (strict schema, no Claude-only envelope in the payload)', () => {
  const bundle = read('hooks/stop.mjs');
  assert.match(bundle, /stopMain\(["']codex["']\)/);
  assert.match(bundle, /strict schema/i);
});

test('manual-only skills carry allow_implicit_invocation:false; the route skill stays implicit', () => {
  const dirs = readdirSync(at('skills'));
  for (const dir of dirs) {
    const guard = at(`skills/${dir}/agents/openai.yaml`);
    if (dir === 'tokenmaxed-route') {
      assert.ok(!existsSync(guard), 'route is the one deliberately model-invocable skill');
    } else {
      assert.ok(existsSync(guard), `${dir}: state-changing/manual skill must block implicit invocation`);
      assert.match(readFileSync(guard, 'utf8'), /allow_implicit_invocation: false/);
    }
  }
});

test('generated skills carry no Claude-Code-specific instructions', () => {
  for (const dir of readdirSync(at('skills'))) {
    const md = read(`skills/${dir}/SKILL.md`);
    for (const token of ['AskUserQuestion', 'start Claude Code', 'Claude stops delegating', 'in Claude Code']) {
      assert.ok(!md.includes(token), `${dir}: residual host-specific token "${token}"`);
    }
  }
});
