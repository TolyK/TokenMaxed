/**
 * F3 — OpenClaw adapter integrity: the manifest is valid, the committed bundles
 * exist with the right process-safety properties, the example config carries
 * the host identity + the finalize-hook requirements, and the generated skills
 * carry OpenClaw naming (never Claude-format names). Pure file reads, no build.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { FINALIZE_HOOK_TIMEOUT_MS } from '../../mcp/src/openclaw-plugin.ts';
import { REVIEW_CHILD_KILL_MS } from '../../mcp/src/review-child.ts';

const at = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string): string => readFileSync(at(rel), 'utf8');
const json = (rel: string): Record<string, unknown> => JSON.parse(read(rel));

test('openclaw.plugin.json: id/name/description present', () => {
  const m = json('openclaw.plugin.json');
  assert.equal(m.id, 'tokenmaxed');
  assert.equal(m.name, 'TokenMaxed');
  assert.ok((m.description as string).length > 0);
});

test('committed bundles exist (server + in-process plugin + review child beside it)', () => {
  assert.ok(existsSync(at('server/index.mjs')), 'server bundle must be committed');
  assert.ok(existsSync(at('index.js')), 'plugin bundle must be committed');
  assert.ok(existsSync(at('tokenmaxed-review.mjs')), 'review child must ship NEXT TO index.js');
});

test('server + review-child bundles default host identity; plugin bundle must NOT mutate process.env or bundle spawnSync', () => {
  assert.match(read('server/index.mjs'), /process\.env\.TOKENMAXED_HOST \?\?= 'openclaw'/);
  assert.match(read('tokenmaxed-review.mjs'), /process\.env\.TOKENMAXED_HOST \?\?= 'openclaw'/);
  // The plugin runs IN-PROCESS in the Gateway: no env mutation, no spawnSync
  // (a blocked event loop would freeze every OpenClaw surface at once).
  assert.doesNotMatch(read('index.js'), /process\.env\.TOKENMAXED_HOST \?\?=/);
  assert.doesNotMatch(read('index.js'), /spawnSync/);
  assert.match(read('tokenmaxed-review.mjs'), /spawnSync/); // …the child is where it lives
});

test('example config: MCP env host identity + the finalize-hook requirements', () => {
  const cfg = json('openclaw.example.json') as {
    mcp: { servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> };
    plugins: { entries: Record<string, { hooks?: { allowConversationAccess?: boolean; timeouts?: Record<string, number> } }> };
  };
  const server = cfg.mcp.servers.tokenmaxed!;
  assert.equal(server.command, 'node');
  assert.match(server.args[0]!, /packages\/openclaw-plugin\/server\/index\.mjs$/);
  assert.equal(server.env?.TOKENMAXED_HOST, 'openclaw');
  const hooks = cfg.plugins.entries.tokenmaxed!.hooks!;
  assert.equal(hooks.allowConversationAccess, true, 'finalize review needs conversation access');
  // Pinned against the REAL constants (not a duplicated literal), so a review-
  // budget change can't silently leave the example timeout too short.
  assert.ok(FINALIZE_HOOK_TIMEOUT_MS > REVIEW_CHILD_KILL_MS, 'hook budget must exceed the child kill budget');
  assert.ok(
    (hooks.timeouts?.before_agent_finalize ?? 0) >= FINALIZE_HOOK_TIMEOUT_MS,
    'example finalize timeout must cover the plugin-requested hook budget',
  );
});

test('generated skills: OpenClaw naming, manual-only preserved, no Claude leftovers', () => {
  const dirs = readdirSync(at('skills'));
  assert.ok(dirs.length >= 13, `expected ≥13 generated skills, got ${dirs.length}`);
  let manualOnlySeen = 0;
  for (const dir of dirs) {
    const md = read(`skills/${dir}/SKILL.md`);
    assert.match(md, new RegExp(`^---\\nname: ${dir}\\n`), `${dir}: name frontmatter`);
    assert.match(md, /\ndescription:\s*\S/, `${dir}: description frontmatter`);
    assert.doesNotMatch(md, /mcp__plugin_tokenmaxed/, `${dir}: Claude tool-name format must be transformed`);
    assert.doesNotMatch(md, /\/tokenmaxed:[a-z]/, `${dir}: /tokenmaxed:* refs must become /tokenmaxed_*`);
    if (md.includes('disable-model-invocation: true')) manualOnlySeen += 1;
    for (const leftover of ['Claude stops delegating', 'in Claude Code', 'Claude offloads', 'Claude invokes', 'AskUserQuestion', 'start Claude Code']) {
      assert.ok(!md.includes(leftover), `${dir}: untransformed host language: "${leftover}"`);
    }
  }
  // OpenClaw supports disable-model-invocation natively — the manual-only
  // guard must SURVIVE generation (unlike hosts needing a separate guard file).
  assert.ok(manualOnlySeen >= 10, `manual-only skills must keep disable-model-invocation (saw ${manualOnlySeen})`);
  // Spot-check a tool reference in OpenClaw's server__tool shape.
  assert.match(read('skills/tokenmaxed-status/SKILL.md'), /tokenmaxed__router_status/);
});

test('reference data ships with the adapter (same set as the other hosts)', () => {
  for (const f of ['prices.seed.json', 'capability-snapshot.v1.json', 'lanes.starter.yaml', 'policy.starter.yaml']) {
    assert.ok(existsSync(at(f)), `${f} must be committed with the adapter`);
  }
});
