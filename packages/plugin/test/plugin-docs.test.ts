/**
 * A-9 docs test — keep the README's Claude Code section honest (the CLI has the
 * analogous usage-docs.test). Ties documented `/tokenmaxed:*` commands to the
 * SHIPPED skills: the README can't document a command that doesn't exist, and
 * every manual command skill must be documented. Pure file reads, no build.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
const SKILLS_DIR = new URL('../skills/', import.meta.url);

/** Skill directory names (each is a /tokenmaxed:<name> command or model skill). */
function skillNames(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Whether a skill is a manual command (disable-model-invocation:true). */
function isManual(name: string): boolean {
  const md = readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
  const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? '';
  return /disable-model-invocation:\s*true/.test(fm);
}

/** Every `/tokenmaxed:<cmd>` referenced in the README. */
function documentedCommands(): Set<string> {
  const found = new Set<string>();
  for (const m of README.matchAll(/\/tokenmaxed:([a-z]+)/g)) found.add(m[1]!);
  return found;
}

test('every /tokenmaxed: command in the README maps to a real shipped skill', () => {
  const documented = documentedCommands();
  assert.ok(documented.size > 0, 'README should document /tokenmaxed: commands');
  const skills = new Set(skillNames());
  for (const cmd of documented) {
    assert.ok(skills.has(cmd), `README documents /tokenmaxed:${cmd} but no skill packages/plugin/skills/${cmd} exists`);
  }
});

test('every manual command skill is documented in the README', () => {
  const documented = documentedCommands();
  for (const name of skillNames()) {
    if (isManual(name)) {
      assert.ok(documented.has(name), `manual skill "${name}" is not documented in the README (Claude Code section)`);
    }
  }
});
