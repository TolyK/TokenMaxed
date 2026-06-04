/**
 * Tests for the pure setup lane-summary helper: the trust→permission mapping (with
 * qualifiers) and the row renderer. No core/I/O.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatLaneSetup, permissionFor } from '../src/lane-setup.ts';
import type { LaneSetupRow } from '../src/lane-setup.ts';

test('permissionFor maps each trust mode with the right qualifiers', () => {
  assert.match(permissionFor('full', 'answer-only'), /repo \+ tools, answer-only/);
  assert.match(permissionFor('full', 'agentic'), /edit files \/ run commands \(agentic\)/);
  assert.match(permissionFor('reader', 'answer-only'), /repo-READ only.*gate.*READER_EGRESS.*repo_read_attestation/);
  assert.match(permissionFor('worker', 'answer-only'), /minimized, scrubbed, NO repo.*gate/);
  assert.match(permissionFor('blocked', 'answer-only'), /never selected/);
});

const row = (over: Partial<LaneSetupRow> & { id: string }): LaneSetupRow => ({
  kind: 'cli', model: 'm', trustMode: 'full', executionMode: 'answer-only', role: 'none', available: true, ...over,
});

test('formatLaneSetup renders model, trust→permission, role, and availability', () => {
  const lines = formatLaneSetup([
    row({ id: 'codex-cli', model: 'gpt-5.5', trustMode: 'full', role: 'active-reviewer' }),
    row({ id: 'minimax-api', kind: 'api', model: 'minimax-m3', rawModel: 'minimax@latest', trustMode: 'worker', role: 'none', available: false }),
  ]);
  const text = lines.join('\n');
  assert.match(text, /codex-cli \[cli\] gpt-5\.5 · trust=full.*role=reviewer \(active\) · available/);
  // @latest shown as raw → resolved; unavailable + worker permission qualifier.
  assert.match(text, /minimax-api \[api\] minimax@latest → minimax-m3 · trust=worker.*NO repo.*role=— · unavailable now/);
});

test('formatLaneSetup shows declared capability when present, and handles empty', () => {
  assert.match(formatLaneSetup([row({ id: 'x', capability: { docs: 0.8, bugfix: 0.6 } })]).join('\n'), /caps docs=0\.8,bugfix=0\.6/);
  assert.deepEqual(formatLaneSetup([]), ['  (no lanes configured)']);
});
