/**
 * F6 — pi adapter integrity: the committed bundles exist with the right
 * process-safety properties, reference data sits one level above the bundle
 * (module-relative resolution), the settings example registers by path, and
 * the generated skills carry pi naming with manual-only preserved NATIVELY.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const at = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string): string => readFileSync(at(rel), 'utf8');

test('committed bundles exist: extension/index.ts (pi discovers <dir>/index.ts) + BOTH children beside it', () => {
  assert.ok(existsSync(at('extension/index.ts')), 'extension bundle must be committed AS index.ts');
  assert.ok(existsSync(at('extension/tokenmaxed-review.mjs')), 'review child must ship NEXT TO index.ts');
  assert.ok(existsSync(at('extension/tokenmaxed-tool.mjs')), 'tool child must ship NEXT TO index.ts');
});

test('in-process safety: no env mutation; tool execution routes through the CHILD', () => {
  const src = read('extension/index.ts');
  // pi loads extensions IN-PROCESS via jiti: never mutate the host env.
  assert.doesNotMatch(src, /process\.env\.TOKENMAXED_HOST \?\?=/);
  // The spawnSync-based executor stack must never RUN on the TUI loop: every
  // execute spawns the tool child. (The spawnSync STRING may appear in the
  // bundle via shared modules — the executed path is what's pinned: the
  // extension references both children and never imports server deps' dispatch
  // wiring directly; unit tests pin the execute behavior.)
  assert.match(src, /tokenmaxed-tool\.mjs/);
  assert.match(src, /tokenmaxed-review\.mjs/);
  for (const child of ['tokenmaxed-review.mjs', 'tokenmaxed-tool.mjs'] as const) {
    const c = read(`extension/${child}`);
    assert.match(c, /spawnSync/, `${child}: the sync work lives in the child`);
    assert.match(c, /process\.env\.TOKENMAXED_HOST \?\?= 'pi'/, `${child}: host identity default`);
  }
});

test('the tool child EXECUTES: a read-only tool round-trips (temp env)', () => {
  const run = spawnSync;
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-pi-tool-'));
  try {
    const res = run(process.execPath, [at('extension/tokenmaxed-tool.mjs'), 'router_savings'], {
      input: '{}',
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        TOKENMAXED_LANES: join(dir, 'lanes.yaml'),
        TOKENMAXED_LEDGER: join(dir, 'ledger.jsonl'),
        TOKENMAXED_STATE: join(dir, 'state.json'),
      },
    });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout.trim().split('\n').pop()!) as { content: Array<{ text: string }>; isError?: boolean };
    assert.notEqual(parsed.isError, true);
    assert.ok(parsed.content[0]!.text.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reference data sits ONE LEVEL ABOVE the bundle (module-relative ../ resolution)', () => {
  for (const f of ['prices.seed.json', 'capability-snapshot.v1.json', 'lanes.starter.yaml', 'policy.starter.yaml']) {
    assert.ok(existsSync(at(f)), `${f} must be committed at the package root`);
  }
});

test('settings example: registers the extension + skills BY PATH with the host-identity note', () => {
  const cfg = JSON.parse(read('pi.settings.example.json')) as { $comment: string; extensions: string[]; skills: string[] };
  assert.match(cfg.extensions[0]!, /packages\/pi-extension\/extension\/index\.ts$/);
  assert.match(cfg.skills[0]!, /packages\/pi-extension\/skills$/);
  assert.match(cfg.$comment, /TOKENMAXED_HOST=pi/);
  assert.match(cfg.$comment, /hosts:/); // the lane-permission consequence is stated
});

test('generated skills: pi naming, manual-only preserved NATIVELY, no Claude leftovers', () => {
  const dirs = readdirSync(at('skills'));
  assert.ok(dirs.length >= 13, `expected ≥13 generated skills, got ${dirs.length}`);
  let manualOnly = 0;
  for (const dir of dirs) {
    const md = read(`skills/${dir}/SKILL.md`);
    assert.match(md, new RegExp(`^---\\nname: ${dir}\\n`), `${dir}: name frontmatter`);
    assert.match(md, /\ndescription:\s*\S/, `${dir}: description frontmatter`);
    assert.doesNotMatch(md, /mcp__plugin_tokenmaxed/, `${dir}: Claude tool-name format must be transformed`);
    assert.doesNotMatch(md, /\/tokenmaxed:[a-z]/, `${dir}: /tokenmaxed:* refs must become /skill:tokenmaxed-*`);
    if (md.includes('disable-model-invocation: true')) manualOnly += 1;
    for (const leftover of ['Claude stops delegating', 'in Claude Code', 'Claude offloads', 'Claude invokes', 'AskUserQuestion', 'start Claude Code']) {
      assert.ok(!md.includes(leftover), `${dir}: untransformed host language: "${leftover}"`);
    }
  }
  // pi honors disable-model-invocation natively — the flag must SURVIVE.
  assert.ok(manualOnly >= 10, `manual-only skills must keep disable-model-invocation (saw ${manualOnly})`);
  assert.match(read('skills/tokenmaxed-status/SKILL.md'), /tokenmaxed_router_status/);
});
