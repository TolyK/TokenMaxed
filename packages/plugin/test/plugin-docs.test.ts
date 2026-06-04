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
const BUNDLE = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');

/**
 * Behavioral opt-in env toggles (off by default) the plugin honors. Config-path
 * vars (TOKENMAXED_LANES/POLICY/…) and BYOK keys are not feature toggles, so
 * they're excluded — this set is the "Optional, off by default" surface plus the
 * global kill-switch.
 */
const OPT_IN_FLAGS = [
  'TOKENMAXED_GATE_READY',
  'TOKENMAXED_REVIEW_ON_STOP',
  'TOKENMAXED_ESCALATE',
  'TOKENMAXED_LEARN_CAPABILITY',
  'TOKENMAXED_READER_EGRESS',
  'TOKENMAXED_DISABLE',
] as const;

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

test('every opt-in env toggle the README documents is one the shipped bundle honors', () => {
  for (const flag of OPT_IN_FLAGS) {
    if (README.includes(flag)) {
      assert.ok(BUNDLE.includes(flag), `README documents ${flag} but the shipped server/index.mjs never reads it`);
    }
  }
});

test('the quality-escalation toggle is documented (C-13) and tied to the outcome it changes', () => {
  // The bundle honors TOKENMAXED_ESCALATE, so the README must explain it...
  assert.ok(BUNDLE.includes('TOKENMAXED_ESCALATE'), 'bundle should read TOKENMAXED_ESCALATE');
  assert.ok(README.includes('TOKENMAXED_ESCALATE'), 'README must document the TOKENMAXED_ESCALATE opt-in');
  // ...including what the user sees: escalation surfaces in the delegate outcome
  // and the savings report, so the doc has to mention both, not just the flag.
  assert.match(README, /router_delegate/, 'README escalation docs must reference the router_delegate outcome');
  assert.match(README, /escalation rate/i, 'README escalation docs must mention the escalation rate in savings');
});

test('the learned-capability toggle is documented (F-1) with its prior + explainability surface', () => {
  // The bundle honors TOKENMAXED_LEARN_CAPABILITY, so the README must explain it...
  assert.ok(BUNDLE.includes('TOKENMAXED_LEARN_CAPABILITY'), 'bundle should read TOKENMAXED_LEARN_CAPABILITY');
  assert.match(README, /TOKENMAXED_LEARN_CAPABILITY/, 'README must document the learned-capability opt-in');
  // ...including the prior framing and where the user sees the adjustment.
  assert.match(README, /prior/i, 'README must frame declared capability as a prior');
  assert.match(README, /learned: declared/, 'README must show the /tokenmaxed:why learned annotation example');
});

test('the reader trust tier is documented (F-2) with its high-friction opt-ins', () => {
  // The bundle honors TOKENMAXED_READER_EGRESS, so the README must explain it...
  assert.ok(BUNDLE.includes('TOKENMAXED_READER_EGRESS'), 'bundle should read TOKENMAXED_READER_EGRESS');
  assert.match(README, /TOKENMAXED_READER_EGRESS/, 'README must document the reader-egress opt-in');
  // ...including the per-lane attestation and the repo-read framing.
  assert.match(README, /repo_read_attestation/, 'README must mention the per-lane reader attestation');
  assert.match(README, /reader-derived/, 'README must mention the reader-derived taint');
});
