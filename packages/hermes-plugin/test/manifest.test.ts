/**
 * F5 — Hermes adapter integrity: committed bundles exist and EXECUTE, the
 * example config carries the host identity + the pre_verify requirements, and
 * the generated skills carry Hermes naming with manual-only preambles. File
 * reads plus two cheap subprocess executions.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const at = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string): string => readFileSync(at(rel), 'utf8');

const HOOKS = ['pre-tool-call.cjs', 'pre-llm-call.cjs', 'pre-verify.cjs'] as const;

test('committed bundles exist: server + three .cjs hook executables', () => {
  assert.ok(existsSync(at('server/index.mjs')), 'server bundle must be committed');
  for (const hook of HOOKS) {
    assert.ok(existsSync(at(`hooks/${hook}`)), `${hook} must be committed`);
    assert.ok((statSync(at(`hooks/${hook}`)).mode & 0o111) !== 0, `${hook} must be executable`);
  }
});

test('bundles default host identity to hermes; hooks are CJS with shebangs', () => {
  assert.match(read('server/index.mjs'), /process\.env\.TOKENMAXED_HOST \?\?= 'hermes'/);
  for (const hook of HOOKS) {
    const src = read(`hooks/${hook}`);
    assert.match(src, /^#!\/usr\/bin\/env node\n/, `${hook}: shebang`);
    assert.match(src, /process\.env\.TOKENMAXED_HOST \?\?= 'hermes'/, `${hook}: host identity default`);
    assert.doesNotMatch(src, /^import /m, `${hook}: must be CJS`);
  }
});

test('the gate bundle EXECUTES: denies our delegate under the kill-switch in Hermes dialect, allows others', () => {
  const env = { ...process.env, TOKENMAXED_DISABLE: '1' };
  const deny = spawnSync(process.execPath, [at('hooks/pre-tool-call.cjs')], {
    input: JSON.stringify({ tool_name: 'mcp_tokenmaxed_router_delegate' }),
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  assert.equal(deny.status, 0, deny.stderr);
  assert.match(deny.stdout, /"decision":"block"/);
  assert.match(deny.stdout, /\/tokenmaxed-on/); // Hermes slash-command dialect
  assert.doesNotMatch(deny.stdout, /\/tokenmaxed:[a-z]/);
  const allow = spawnSync(process.execPath, [at('hooks/pre-tool-call.cjs')], {
    input: JSON.stringify({ tool_name: 'terminal' }),
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  assert.equal(allow.stdout, '{}');
});

test('example config: MCP env host identity + hook wiring + the pre_verify clamp note', () => {
  const yaml = read('hermes.config.example.yaml');
  assert.match(yaml, /TOKENMAXED_HOST: "hermes"/);
  assert.match(yaml, /matcher: "\^mcp_tokenmaxed_router_delegate\$"/); // ANCHORED — no prefix-name subprocess waste
  for (const hook of HOOKS) assert.match(yaml, new RegExp(`hooks/${hook.replace('.', '\\.')}`), `${hook} wired`);
  // The pre_verify hook timeout must sit at Hermes's 300s clamp (the inline
  // review needs 270s inside it) — pin the recipe's number.
  assert.match(yaml, /pre-verify\.cjs"\n\s+timeout: 300/);
  assert.match(yaml, /hooks_auto_accept: true/); // headless runs silently skip unaccepted hooks
  assert.match(yaml, /external_dirs:/); // skills load in place, no copying
});

test('generated skills: Hermes naming, manual-only preamble, no Claude leftovers', () => {
  const dirs = readdirSync(at('skills'));
  assert.ok(dirs.length >= 13, `expected ≥13 generated skills, got ${dirs.length}`);
  let manualNotes = 0;
  for (const dir of dirs) {
    const md = read(`skills/${dir}/SKILL.md`);
    assert.match(md, new RegExp(`^---\\nname: ${dir}\\n`), `${dir}: name frontmatter`);
    assert.match(md, /\ndescription:\s*\S/, `${dir}: description frontmatter`);
    assert.doesNotMatch(md, /mcp__plugin_tokenmaxed/, `${dir}: Claude tool-name format must be transformed`);
    assert.doesNotMatch(md, /\/tokenmaxed:[a-z]/, `${dir}: /tokenmaxed:* refs must become /tokenmaxed-*`);
    assert.doesNotMatch(md, /disable-model-invocation/, `${dir}: Claude-only frontmatter must be dropped`);
    if (md.includes('MANUAL-ONLY')) manualNotes += 1;
    for (const leftover of ['Claude stops delegating', 'in Claude Code', 'Claude offloads', 'Claude invokes', 'AskUserQuestion', 'start Claude Code']) {
      assert.ok(!md.includes(leftover), `${dir}: untransformed host language: "${leftover}"`);
    }
  }
  assert.ok(manualNotes >= 10, `manual-only skills must carry the MANUAL-ONLY preamble (saw ${manualNotes})`);
  assert.match(read('skills/tokenmaxed-status/SKILL.md'), /mcp_tokenmaxed_router_status/);
});

test('reference data ships with the adapter (same set as the other hosts)', () => {
  for (const f of ['prices.seed.json', 'capability-snapshot.v1.json', 'lanes.starter.yaml', 'policy.starter.yaml']) {
    assert.ok(existsSync(at(f)), `${f} must be committed with the adapter`);
  }
});
