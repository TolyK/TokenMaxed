import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parseArgs } from '../src/render.ts';

const README = readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8');

/** Every `tokenmaxed <command>` mentioned in the README, de-duplicated. */
function documentedCommands(): string[] {
  const found = new Set<string>();
  for (const m of README.matchAll(/\btokenmaxed\s+([a-z]+)/g)) found.add(m[1]!);
  return [...found];
}

test('every command documented in the README is accepted by the CLI parser', () => {
  const docCommands = documentedCommands();
  assert.ok(docCommands.length > 0, 'README should document tokenmaxed commands');
  for (const cmd of docCommands) {
    // Must parse without throwing, and resolve to that command (docs ⇒ working CLI).
    assert.equal(parseArgs([cmd]).command, cmd, `README documents "tokenmaxed ${cmd}" but the CLI rejects it`);
  }
});

test('the README documents every real CLI command (no undocumented surface)', () => {
  const documented = new Set(documentedCommands());
  for (const cmd of ['savings', 'tokens', 'outcomes', 'lanes', 'help']) {
    assert.ok(documented.has(cmd), `CLI command "${cmd}" is not documented in the README`);
  }
});
