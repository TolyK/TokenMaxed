/**
 * A-3 tests — guard the /tokenmaxed:* manual skills. Pure file reads, no build.
 * Each skill must: have YAML frontmatter with a description and
 * disable-model-invocation:true (manual command, not auto-invoked), and its body
 * must reference the EXACT plugin MCP tool name it drives — the format Claude
 * Code exposes for plugin servers (`mcp__plugin_<plugin>_<server>__<tool>`),
 * verified in A-2. If that format or a tool name changes, this fails loudly.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SKILLS: ReadonlyArray<{ name: string; tool: string }> = [
  { name: 'savings', tool: 'mcp__plugin_tokenmaxed_tokenmaxed__router_savings' },
  { name: 'tokens', tool: 'mcp__plugin_tokenmaxed_tokenmaxed__router_tokens' },
  { name: 'why', tool: 'mcp__plugin_tokenmaxed_tokenmaxed__router_preview' },
];

function readSkill(name: string): string {
  return readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
}

/** Extract the leading `---`…`---` frontmatter block (or empty string). */
function frontmatter(md: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  return m ? m[1]! : '';
}

for (const { name, tool } of SKILLS) {
  test(`skill ${name}: manual-only frontmatter with a description`, () => {
    const fm = frontmatter(readSkill(name));
    assert.ok(fm.length > 0, `${name} should have YAML frontmatter`);
    assert.match(fm, /disable-model-invocation:\s*true/, `${name} must be manual-only`);
    assert.match(fm, /description:\s*\S/, `${name} must have a description`);
  });

  test(`skill ${name}: body drives the correct plugin MCP tool`, () => {
    const body = readSkill(name);
    assert.ok(body.includes(tool), `${name} body must reference ${tool}`);
  });
}
