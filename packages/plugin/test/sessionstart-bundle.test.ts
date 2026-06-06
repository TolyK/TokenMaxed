/**
 * Compiled-BUNDLE smoke test for the SessionStart banner. The shipped artifact is
 * the bundled `hooks/sessionstart.mjs` (not the TS source), so we exercise THAT:
 * spawn it as Claude Code would and assert its stdout contract. Guards the
 * VISIBLE-STARTUP-SUMMARY wiring against a stale/broken bundle (a regression class
 * caught before) — the source-level summary.test.ts can't see the bundle.
 *
 * Hermetic: a throwaway state dir + non-existent lanes/ledger paths, so the result
 * never depends on the developer's ~/.tokenmaxed. Run `npm run build:plugin` first;
 * a missing bundle fails loudly here rather than silently shipping stale.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const BUNDLE = fileURLToPath(new URL('../hooks/sessionstart.mjs', import.meta.url));

/** Run the bundled hook with a hermetic env; returns {stdout, status}. */
function runHook(extraEnv: Record<string, string> = {}): { stdout: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'tmax-sessionstart-'));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, // node + lane-probe lookups
    HOME: dir,
    TOKENMAXED_STATE: join(dir, 'state.json'),
    TOKENMAXED_LANES: join(dir, 'no-such-lanes.yaml'), // ⇒ empty lane set (deterministic)
    TOKENMAXED_LEDGER: join(dir, 'no-such-ledger.jsonl'), // ⇒ empty ledger
    TOKENMAXED_PRICES: join(dir, 'no-such-prices.json'), // ⇒ no staleness
    TOKENMAXED_GATE_READY: 'true',
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [BUNDLE], { env, encoding: 'utf8', input: '' });
  return { stdout: r.stdout ?? '', status: r.status };
}

test('the SessionStart bundle exists (run `npm run build:plugin`)', () => {
  assert.ok(existsSync(BUNDLE), `missing bundle: ${BUNDLE}`);
});

test('bundle emits parseable JSON whose systemMessage === additionalContext (single source)', () => {
  const { stdout, status } = runHook();
  assert.equal(status, 0, 'hook must always exit 0');
  const parsed = JSON.parse(stdout) as {
    systemMessage?: string;
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  assert.equal(parsed.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.equal(typeof parsed.systemMessage, 'string');
  assert.ok(parsed.systemMessage!.length > 0, 'systemMessage must be the visible banner');
  // The byte-identity guarantee the plan promised: user-visible == model-context.
  assert.equal(parsed.systemMessage, parsed.hookSpecificOutput?.additionalContext);
});

test('kill-switch (TOKENMAXED_DISABLE=1) makes the bundle emit NOTHING', () => {
  const { stdout, status } = runHook({ TOKENMAXED_DISABLE: '1' });
  assert.equal(status, 0);
  assert.equal(stdout.trim(), '');
});
