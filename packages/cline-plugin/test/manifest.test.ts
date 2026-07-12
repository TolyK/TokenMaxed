/**
 * F4 — Cline adapter integrity: committed bundles exist with the right
 * process/module-scope properties, the example MCP config carries the host
 * identity, Windows wrappers ship, and the generated skills carry Cline naming
 * with manual-only semantics preserved as a body preamble. Pure file reads.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const at = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string): string => readFileSync(at(rel), 'utf8');

test('committed bundles exist: server + the two extensionless hook executables + Windows wrappers', () => {
  assert.ok(existsSync(at('server/index.mjs')), 'server bundle must be committed');
  for (const hook of ['PreToolUse', 'TaskStart'] as const) {
    assert.ok(existsSync(at(`hooks/${hook}`)), `${hook} must be committed (extensionless — the VS Code extension requires the exact name)`);
    assert.ok(existsSync(at(`hooks/${hook}.ps1`)), `${hook}.ps1 Windows wrapper must be committed`);
    // The exec bit is load-bearing: the extension only runs +x hook files.
    assert.ok((statSync(at(`hooks/${hook}`)).mode & 0o111) !== 0, `${hook} must be executable`);
  }
});

test('hook bundles: shebang + DUAL module-scope shims + host identity default; server bundle defaults host', () => {
  assert.match(read('server/index.mjs'), /process\.env\.TOKENMAXED_HOST \?\?= 'cline'/);
  for (const hook of ['PreToolUse', 'TaskStart'] as const) {
    const src = read(`hooks/${hook}`);
    assert.match(src, /^#!\/usr\/bin\/env node\n/, `${hook}: shebang`);
    // Extensionless files parse as CJS in a bare dir but as ESM near a
    // type:module package.json — the shims must cover BOTH scopes.
    assert.match(src, /typeof require !== 'undefined' \? require : process\.getBuiltinModule/, `${hook}: dual-scope require shim`);
    assert.match(src, /process\.env\.TOKENMAXED_HOST \?\?= 'cline'/, `${hook}: host identity default`);
    assert.doesNotMatch(src, /^import /m, `${hook}: must be CJS (no ESM import statements)`);
  }
});

test('PreToolUse bundle EXECUTES in both module scopes (bare-dir CJS + in-repo ESM)', () => {
  const payload = JSON.stringify({ preToolUse: { toolName: 'tokenmaxed__router_delegate' } });
  const env = { ...process.env, TOKENMAXED_DISABLE: '1' };
  // In-repo: the package's type:module makes node parse the extensionless file as ESM.
  const esm = spawnSync(process.execPath, [at('hooks/PreToolUse')], { input: payload, encoding: 'utf8', env, timeout: 30_000 });
  assert.equal(esm.status, 0, esm.stderr);
  assert.match(esm.stdout, /"cancel":true/, 'ESM scope must deny under the kill-switch');
  // Bare temp dir: no package.json nearby ⇒ CJS scope (the normal installed case).
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-cline-scope-'));
  try {
    copyFileSync(at('hooks/PreToolUse'), join(dir, 'PreToolUse'));
    const cjs = spawnSync(process.execPath, [join(dir, 'PreToolUse')], { input: payload, encoding: 'utf8', env, timeout: 30_000 });
    assert.equal(cjs.status, 0, cjs.stderr);
    assert.match(cjs.stdout, /"cancel":true/, 'CJS scope must deny under the kill-switch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('example MCP config: env host identity + delegate NOT auto-approved', () => {
  const cfg = JSON.parse(read('cline_mcp_settings.example.json')) as {
    mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string>; autoApprove?: string[] }>;
  };
  const server = cfg.mcpServers.tokenmaxed!;
  assert.equal(server.command, 'node');
  assert.match(server.args[0]!, /packages\/cline-plugin\/server\/index\.mjs$/);
  assert.equal(server.env?.TOKENMAXED_HOST, 'cline');
  // Read-only tools may be auto-approved; the delegate (which EXECUTES work on
  // other lanes) must stay behind the approval prompt.
  assert.ok(!server.autoApprove?.includes('router_delegate'), 'router_delegate must not be auto-approved');
});

test('generated skills: Cline naming, manual-only preamble, no Claude leftovers', () => {
  const dirs = readdirSync(at('skills'));
  assert.ok(dirs.length >= 13, `expected ≥13 generated skills, got ${dirs.length}`);
  let manualNotes = 0;
  for (const dir of dirs) {
    const md = read(`skills/${dir}/SKILL.md`);
    assert.match(md, new RegExp(`^---\\nname: ${dir}\\n`), `${dir}: name frontmatter must equal the dir name (Cline requires it)`);
    assert.match(md, /\ndescription:\s*\S/, `${dir}: description frontmatter`);
    const desc = /\ndescription:\s*(.+)/.exec(md)![1]!;
    assert.ok(desc.length <= 1024, `${dir}: description exceeds Cline's 1024-char frontmatter limit (${desc.length})`);
    assert.doesNotMatch(md, /mcp__plugin_tokenmaxed/, `${dir}: Claude tool-name format must be transformed`);
    assert.doesNotMatch(md, /\/tokenmaxed:[a-z]/, `${dir}: /tokenmaxed:* refs must become /tokenmaxed-*`);
    // Cline's frontmatter contract is name+description only — the Claude flag
    // must be dropped, its semantics preserved as the body preamble.
    assert.doesNotMatch(md, /disable-model-invocation/, `${dir}: Claude-only frontmatter must be dropped`);
    if (md.includes('MANUAL-ONLY')) manualNotes += 1;
    for (const leftover of ['Claude stops delegating', 'in Claude Code', 'Claude offloads', 'Claude invokes', 'AskUserQuestion', 'start Claude Code']) {
      assert.ok(!md.includes(leftover), `${dir}: untransformed host language: "${leftover}"`);
    }
  }
  assert.ok(manualNotes >= 10, `manual-only skills must carry the MANUAL-ONLY preamble (saw ${manualNotes})`);
  assert.match(read('skills/tokenmaxed-status/SKILL.md'), /tokenmaxed__router_status/);
});

test('reference data ships with the adapter (same set as the other hosts)', () => {
  for (const f of ['prices.seed.json', 'capability-snapshot.v1.json', 'lanes.starter.yaml', 'policy.starter.yaml']) {
    assert.ok(existsSync(at(f)), `${f} must be committed with the adapter`);
  }
});
