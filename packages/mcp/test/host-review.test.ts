/**
 * selectManagerLane availability filtering: the host-turn reviewer (/tokenmaxed:review
 * and the Stop gate) must not select a manager lane that can't run now (e.g. Codex
 * not installed), or it would fail to spawn instead of falling through to an
 * available manager.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectManagerLane } from '../src/host-review.ts';
import type { Lane, Policy } from '@tokenmaxed/core';

const mgr = (over: Partial<Lane> & { id: string }): Lane => ({
  kind: 'cli',
  model: 'm',
  trust_mode: 'full',
  costBasis: 'subscription',
  provenance: 'anthropic',
  jurisdiction: 'US',
  manager_allowed: true,
  roles: ['manager'],
  command: 'x',
  ...over,
});

const codex = mgr({ id: 'codex-cli', provenance: 'openai', command: 'codex' });
const haiku = mgr({ id: 'claude-haiku', provenance: 'anthropic', command: 'claude' });
const lanes = [codex, haiku]; // file order: Codex is the first eligible manager
const noPolicy: Policy = {};

test('selectManagerLane picks the first eligible manager when availability is unchecked', () => {
  assert.equal(selectManagerLane(lanes, noPolicy, true)?.id, 'codex-cli');
});

test('selectManagerLane skips an unavailable manager and falls through to an available one', () => {
  // Codex not installed ⇒ not in the available set ⇒ Haiku is selected instead.
  assert.equal(selectManagerLane(lanes, noPolicy, true, new Set(['claude-haiku']))?.id, 'claude-haiku');
});

test('selectManagerLane keeps the first manager when it IS available', () => {
  assert.equal(selectManagerLane(lanes, noPolicy, true, new Set(['codex-cli', 'claude-haiku']))?.id, 'codex-cli');
});

test('selectManagerLane returns undefined when no eligible manager is available', () => {
  assert.equal(selectManagerLane(lanes, noPolicy, true, new Set<string>()), undefined);
});
