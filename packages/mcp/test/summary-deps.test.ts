/**
 * Glue test for makeSummaryFromEnv — the env→summary wiring shared by the
 * router_summary server dep and the SessionStart hook. Uses non-existent config
 * paths so it exercises the empty/new-user path and the disable flag without any
 * fixtures or network (no lanes ⇒ nothing to probe).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeSummaryFromEnv } from '../src/summary-deps.ts';

const baseEnv = (): NodeJS.ProcessEnv => ({
  TOKENMAXED_LANES: '/no/such/lanes.yaml',
  TOKENMAXED_LEDGER: '/no/such/ledger.jsonl',
  TOKENMAXED_STATE: '/no/such/state.json',
  TOKENMAXED_PROJECT: 'proj',
});

test('empty config ⇒ empty summary, enabled by default, three windows, no lanes', async () => {
  const data = await makeSummaryFromEnv(baseEnv())();
  assert.equal(data.empty, true);
  assert.equal(data.enabled, true); // no stored toggle ⇒ default enabled
  assert.deepEqual(data.windows.map((w) => w.label), ['24h', '7d', 'lifetime']);
  assert.deepEqual(data.lanes, []);
  assert.equal(data.activeReviewerId, undefined);
  assert.equal(data.meteredAvoidedLifetime, 0);
});

test('TOKENMAXED_DISABLE forces enabled:false (kill-switch)', async () => {
  const data = await makeSummaryFromEnv({ ...baseEnv(), TOKENMAXED_DISABLE: '1' })();
  assert.equal(data.enabled, false);
});
