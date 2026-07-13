import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeDecide } from '../src/route.ts';
import { laneQuotaState } from '../src/quota.ts';
import { parseLaneConfig } from '../src/registry.ts';
import { FIVE_HOUR_MS } from '../src/window-quota.ts';
import { SCHEMA_VERSION } from '../src/ledger.ts';
import type { Lane, Policy, RouteContext, Task } from '../src/types.ts';
import type { TaskEvent } from '../src/ledger.ts';

const NOW = Date.parse('2026-07-11T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let seq = 0;
function taskEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    event_type: 'task',
    schema_version: SCHEMA_VERSION,
    id: `t-${seq}`,
    seq: seq++,
    ts: new Date(NOW - HOUR).toISOString(),
    task_id: `task-${seq}`,
    attempt: 0,
    category: 'bugfix',
    laneId: 'lane-a',
    model: 'model-a',
    trust_mode: 'full',
    provenance: 'openai',
    status: 'ok',
    tokens_in: 1000,
    tokens_out: 500,
    tokens_estimated: false,
    actual_cost: 0,
    frontier_cost: 1,
    metered_spent: 0,
    frontier_avoided: 1,
    metered_avoided: 1,
    policy_verdict: 'allow',
    ...overrides,
  };
}

const lane = (over: Partial<Lane> & { id: string }): Lane => ({
  kind: 'cli', model: 'm', trust_mode: 'full', costBasis: 'subscription',
  provenance: 'openai', jurisdiction: 'US', ...over,
});

test('reserve core: no-reservation path is byte-identical to original behavior', () => {
  const laneA = lane({ id: 'lane-a', requests_per_window: 10 });
  const s = laneQuotaState([taskEvent({ laneId: 'lane-a' })], laneA, NOW);
  // With 1 request used of 10 limit: raw used is 0.1, headroom is 0.9.
  assert.equal(s.window?.used, 0.1);
  assert.equal(s.headroom, 0.9);
});

test('reserve core: reservation scaling is correct and reaches thresholds earlier', () => {
  const laneA = lane({ id: 'lane-a', requests_per_window: 10, reserve_fraction: 0.20 });
  const s = laneQuotaState([taskEvent({ laneId: 'lane-a' })], laneA, NOW);
  // 1 used of 10 limit, 20% reserve.
  // Raw used = 0.1. Scaled used = 0.1 / (1 - 0.2) = 0.1 / 0.8 = 0.125.
  // Headroom = 1 - 0.125 = 0.875.
  assert.equal(s.window?.used, 0.125);
  assert.equal(s.headroom, 0.875);
});

test('reserve core: reservation deprioritizes a lane earlier (reserved near-reserve lane loses to equal un-reserved lane)', () => {
  // lane-a and lane-b have the same capability (0.9), but lane-a is reserved and has used 8 requests out of 10 limit, with 20% reserve.
  // Usable cap for lane-a: 10 * 0.8 = 8.
  // 8 requests used means lane-a is at its reserve limit (scaled used = 8 / 8 = 1.0, which is critical).
  // lane-b is un-reserved and has used 5 requests out of 10 limit (scaled used = 5 / 10 = 0.5, which is ok).
  const laneA = lane({
    id: 'lane-a',
    requests_per_window: 10,
    reserve_fraction: 0.20,
    capability: { bugfix: 0.9 },
  });
  const laneB = lane({
    id: 'lane-b',
    requests_per_window: 10,
    capability: { bugfix: 0.9 },
  });

  const events = [
    // 8 requests for lane-a
    ...Array.from({ length: 8 }, () => taskEvent({ laneId: 'lane-a' })),
    // 5 requests for lane-b
    ...Array.from({ length: 5 }, () => taskEvent({ laneId: 'lane-b' })),
  ];

  const sA = laneQuotaState(events, laneA, NOW);
  const sB = laneQuotaState(events, laneB, NOW);

  assert.equal(sA.window?.level, 'critical'); // scaled used = 1.0 -> critical
  assert.equal(sB.window?.level, 'ok'); // used = 0.5 -> ok

  const routeCtx: RouteContext = {
    lanes: [laneA, laneB],
    capHeadroom: {
      'lane-a': sA.headroom,
      'lane-b': sB.headroom,
    },
  };

  const d = routeDecide({ category: 'bugfix' }, routeCtx, {});
  assert.equal(d.laneId, 'lane-b'); // lane-b wins because lane-a has critical cap penalty (1.0)
});

test('reserve core: a reserved lane is STILL selected when it is the only capable one', () => {
  // lane-a is reserved and at critical capacity (over reserve limit).
  // But lane-a is the only candidate lane. It must still be selected.
  const laneA = lane({
    id: 'lane-a',
    requests_per_window: 10,
    reserve_fraction: 0.20,
    capability: { bugfix: 0.9 },
  });

  const events = Array.from({ length: 9 }, () => taskEvent({ laneId: 'lane-a' }));
  const sA = laneQuotaState(events, laneA, NOW);

  const routeCtx: RouteContext = {
    lanes: [laneA],
    capHeadroom: {
      'lane-a': sA.headroom,
    },
  };

  const d = routeDecide({ category: 'bugfix' }, routeCtx, {});
  assert.equal(d.laneId, 'lane-a'); // Still selected because it's the only capable lane!
});

test('reserve core: registry validation of reserve_fraction', () => {
  const base = {
    id: 'x', kind: 'cli', model: 'm', command: 'node', trust_mode: 'full',
    costBasis: 'subscription', provenance: 'openai', jurisdiction: 'US',
  };

  // Accept valid values: 0, 1, 0.5
  for (const val of [0, 1, 0.5]) {
    const registry = parseLaneConfig(
      JSON.stringify({ lanes: [{ ...base, reserve_fraction: val }] })
    );
    assert.equal(registry.lanes[0]!.reserve_fraction, val);
  }

  // Reject invalid values: -1, 1.01, a string, non-finite
  for (const val of [-1, 1.01, '0.5', NaN, Infinity]) {
    assert.throws(
      () => parseLaneConfig(JSON.stringify({ lanes: [{ ...base, reserve_fraction: val }] })),
      /reserve_fraction/
    );
  }
});
