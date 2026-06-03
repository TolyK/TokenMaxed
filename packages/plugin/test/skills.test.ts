/**
 * A-3/A-4/A-5 tests — guard the /tokenmaxed:* skills. Pure file reads, no build.
 * Manual skills must have a description + disable-model-invocation:true (command,
 * not auto-invoked); the `route` skill is model-invoked (NO disable flag) so
 * Claude can surface offloading. Every skill body must reference the EXACT plugin
 * MCP tool name it drives — the format Claude Code exposes for plugin servers
 * (`mcp__plugin_<plugin>_<server>__<tool>`), verified in A-2. Drift fails loudly.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const P = 'mcp__plugin_tokenmaxed_tokenmaxed__';

/** Manual command skills (disable-model-invocation:true). */
const MANUAL_SKILLS: ReadonlyArray<{ name: string; tool: string }> = [
  { name: 'savings', tool: `${P}router_savings` },
  { name: 'tokens', tool: `${P}router_tokens` },
  { name: 'why', tool: `${P}router_preview` },
  { name: 'off', tool: `${P}router_set_enabled` },
  { name: 'on', tool: `${P}router_set_enabled` },
  { name: 'status', tool: `${P}router_status` },
];

/** Model-invoked guidance skills (no disable flag). */
const MODEL_SKILLS: ReadonlyArray<{ name: string; tool: string }> = [
  { name: 'route', tool: `${P}router_delegate` },
];

function readSkill(name: string): string {
  return readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
}

/** Extract the leading `---`…`---` frontmatter block (or empty string). */
function frontmatter(md: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  return m ? m[1]! : '';
}

for (const { name, tool } of MANUAL_SKILLS) {
  test(`skill ${name}: manual-only frontmatter with a description`, () => {
    const fm = frontmatter(readSkill(name));
    assert.ok(fm.length > 0, `${name} should have YAML frontmatter`);
    assert.match(fm, /disable-model-invocation:\s*true/, `${name} must be manual-only`);
    assert.match(fm, /description:\s*\S/, `${name} must have a description`);
  });

  test(`skill ${name}: body drives the correct plugin MCP tool`, () => {
    assert.ok(readSkill(name).includes(tool), `${name} body must reference ${tool}`);
  });
}

for (const { name, tool } of MODEL_SKILLS) {
  test(`skill ${name}: model-invoked (no disable flag) with a description`, () => {
    const fm = frontmatter(readSkill(name));
    assert.ok(fm.length > 0, `${name} should have YAML frontmatter`);
    assert.doesNotMatch(fm, /disable-model-invocation:\s*true/, `${name} must be model-invoked`);
    assert.match(fm, /description:\s*\S/, `${name} must have a description`);
  });

  test(`skill ${name}: body drives the correct plugin MCP tool`, () => {
    assert.ok(readSkill(name).includes(tool), `${name} body must reference ${tool}`);
  });
}
