/**
 * B1 — quota-brain state: config validation (registry), weighted observation
 * extraction, per-axis state (window / weekly requests / weekly tokens),
 * min-across-axes headroom, and the omit-when-unconfigured invariant.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SCHEMA_VERSION } from '../src/ledger.ts';
import type { LedgerEvent, TaskEvent } from '../src/ledger.ts';
import { laneObservations, laneQuotaState, quotaHeadroomMap, WEEK_MS, computePacePressure, adjustHeadroomForPace, laneDepletionForecast, projectOccupancy } from '../src/quota.ts';
import { parseLaneConfig } from '../src/registry.ts';
import type { Lane } from '../src/types.ts';
import { FIVE_HOUR_MS } from '../src/window-quota.ts';

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
    laneId: 'codex-cli',
    model: 'gpt-5.5',
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

// --- registry validation ------------------------------------------------------

test('registry: quota fields accept positive finite numbers and reject the rest', () => {
  const base = {
    id: 'x', kind: 'cli', model: 'm', command: 'node', trust_mode: 'full',
    costBasis: 'subscription', provenance: 'openai', jurisdiction: 'US',
  };
  // parseLaneConfig takes YAML text; JSON is a YAML subset, so stringify works.
  const good = parseLaneConfig(
    JSON.stringify({ lanes: [{ ...base, window_ms: 3_600_000, requests_per_week: 500, tokens_per_week: 1_000_000 }] }),
  );
  const l = good.lanes[0]!;
  assert.equal(l.window_ms, 3_600_000);
  assert.equal(l.requests_per_week, 500);
  assert.equal(l.tokens_per_week, 1_000_000);
  for (const bad of [{ window_ms: 0 }, { requests_per_week: -1 }, { tokens_per_week: 'many' }, { window_ms: -5 }]) {
    assert.throws(() => parseLaneConfig(JSON.stringify({ lanes: [{ ...base, ...bad }] })), /positive finite number/);
  }
});

// --- observations ---------------------------------------------------------------

test('laneObservations: routed legs only, weighted per axis, invalid timestamps dropped', () => {
  const events: LedgerEvent[] = [
    taskEvent(),
    taskEvent({ status: 'native', native_reason: 'no_route' }), // not routed
    taskEvent({ laneId: 'other' }), // other lane
    taskEvent({ ts: 'not-a-date' }), // invalid ts
    taskEvent({ status: 'failed' }), // failed leg still consumed quota
  ];
  const reqs = laneObservations(events, 'codex-cli', false);
  assert.equal(reqs.length, 2);
  assert.ok(reqs.every((o) => o.amount === 1));
  const toks = laneObservations(events, 'codex-cli', true);
  assert.ok(toks.every((o) => o.amount === 1500));
});

// --- state ----------------------------------------------------------------------

test('laneQuotaState: no quota config ⇒ headroom 1, no axes (zero-change invariant)', () => {
  const s = laneQuotaState([taskEvent()], lane({ id: 'codex-cli' }), NOW);
  assert.deepEqual(s, { headroom: 1 });
});

test('laneQuotaState: window axis counts inside window_ms override; old events age out', () => {
  const l = lane({ id: 'codex-cli', requests_per_window: 10, window_ms: 2 * HOUR });
  const events = [
    taskEvent(), // 1h ago — inside the 2h window
    taskEvent({ ts: new Date(NOW - 3 * HOUR).toISOString() }), // outside 2h
  ];
  const s = laneQuotaState(events, l, NOW);
  assert.equal(s.window?.count, 1);
  assert.equal(s.window?.limit, 10);
  assert.equal(s.window?.level, 'ok');
  // Default window (5h) would count both.
  const s5 = laneQuotaState(events, lane({ id: 'codex-cli', requests_per_window: 10 }), NOW);
  assert.equal(s5.window?.count, 2);
});

test('laneQuotaState: weekly axes count 7d trailing; tokens weighted; levels at 0.7/0.9', () => {
  const l = lane({ id: 'codex-cli', requests_per_week: 10, tokens_per_week: 15_000 });
  const events: LedgerEvent[] = [];
  for (let i = 0; i < 7; i++) events.push(taskEvent({ ts: new Date(NOW - (i + 1) * 12 * HOUR).toISOString() }));
  events.push(taskEvent({ ts: new Date(NOW - WEEK_MS - HOUR).toISOString() })); // aged out
  const s = laneQuotaState(events, l, NOW);
  assert.equal(s.weekRequests?.count, 7);
  assert.equal(s.weekRequests?.level, 'warn'); // 7/10 = 0.7
  assert.equal(s.weekTokens?.count, 7 * 1500);
  assert.equal(s.weekTokens?.level, 'warn'); // 10500/15000 = 0.7 ⇒ warn threshold exactly
});

test('laneQuotaState: headroom is the MIN across configured axes and floors at 0', () => {
  const l = lane({ id: 'codex-cli', requests_per_window: 100, tokens_per_week: 1_000 });
  const events = [taskEvent(), taskEvent(), taskEvent()]; // 3 reqs, 4500 tokens (over the 1k cap)
  const s = laneQuotaState(events, l, NOW);
  assert.equal(s.window?.count, 3);
  assert.ok(Math.abs(s.headroom - 0) < 1e-9); // token axis exhausted ⇒ min = 0
});

// --- headroom map ----------------------------------------------------------------

test('quotaHeadroomMap: only quota-configured lanes appear (empty map when none)', () => {
  const events = [taskEvent()];
  const none = quotaHeadroomMap(events, [lane({ id: 'codex-cli' }), lane({ id: 'b' })], NOW);
  assert.equal(Object.keys(none).length, 0);
  const some = quotaHeadroomMap(events, [lane({ id: 'codex-cli', requests_per_window: 2 }), lane({ id: 'b' })], NOW);
  assert.deepEqual(Object.keys(some), ['codex-cli']);
  assert.ok(Math.abs(some['codex-cli']! - 0.5) < 1e-9); // 1/2 used
});

// --- B3: depletion projection ----------------------------------------------------

import type { QuotaObservation } from '../src/quota.ts';

const W = 100_000; // test window (ms)

/** n observations of `amount`, evenly spaced across [NOW-spanFrom, NOW-spanTo]. */
function spread(n: number, fromAgo: number, toAgo: number, amount = 1): QuotaObservation[] {
  const out: QuotaObservation[] = [];
  const step = n > 1 ? (fromAgo - toAgo) / (n - 1) : 0;
  for (let i = 0; i < n; i++) out.push({ ts: NOW - (fromAgo - i * step), amount });
  return out;
}

test('projectOccupancy: steady state (balanced arrivals/expirations) yields NO eta', () => {
  // 20 obs evenly across the window: occupancy oscillates, never rises to the limit.
  const obs = spread(20, 97_500, 2_500);
  assert.equal(projectOccupancy(obs, 22, W, NOW), undefined);
});

test('projectOccupancy: rising rate projects an ANALYTIC crossing (net of expirations)', () => {
  // First half 6 obs, second half 12 (ratio 2 ⇒ moderate); occupancy 18, limit 20.
  // Expirations: 6 in (now, now+30k], then none until +52k; crossing lands in the
  // gap at t* = 30000 + (20 - 17.4)/1.8e-4 = 44444.44… ms.
  const obs = [...spread(6, 95_000, 70_000), ...spread(12, 48_000, 4_000)];
  const p = projectOccupancy(obs, 20, W, NOW);
  assert.ok(p, 'expected a projection');
  assert.equal(p!.confidence, 'moderate'); // span 91% ≥ 50%, ratio 2 ≤ 2
  assert.ok(Math.abs(p!.etaMs - (30_000 + 2.6 / 1.8e-4)) < 0.01, `eta ${p!.etaMs}`);
});

test('projectOccupancy: same-instant tie resolves expiration-first (no crossing)', () => {
  // 8 obs every 10k, occ 8, λ=8e-5; limit hit EXACTLY at the first expiration
  // (+10k) — the expiring unit drops first, and net drift is negative ⇒ no eta.
  const obs = spread(8, 90_000, 20_000);
  assert.equal(projectOccupancy(obs, 8 + 8e-5 * 10_000, W, NOW), undefined);
});

test('projectOccupancy: evidence gates — samples, span, zero-half, ratio', () => {
  assert.equal(projectOccupancy(spread(7, 90_000, 20_000), 100, W, NOW), undefined); // < 8 samples
  assert.equal(projectOccupancy(spread(10, 20_000, 1_000), 100, W, NOW), undefined); // span 19% < 25%
  assert.equal(projectOccupancy(spread(10, 45_000, 5_000), 100, W, NOW), undefined); // first half zero
  const bursty = [...spread(2, 95_000, 90_000), ...spread(8, 45_000, 5_000)]; // ratio 4 ≥ 3
  assert.equal(projectOccupancy(bursty, 100, W, NOW), undefined);
});

test('projectOccupancy: already at/over the limit projects eta 0', () => {
  const obs = spread(20, 97_500, 2_500);
  const p = projectOccupancy(obs, 20, W, NOW);
  assert.equal(p?.etaMs, 0);
});

test('projectOccupancy: token weights drive the weighted series', () => {
  // Same shape as the rising case but each obs carries 100 tokens ⇒ same eta
  // against a 100×-scaled limit.
  const obs = [...spread(6, 95_000, 70_000, 100), ...spread(12, 48_000, 4_000, 100)];
  const p = projectOccupancy(obs, 2_000, W, NOW);
  assert.ok(p);
  assert.ok(Math.abs(p!.etaMs - (30_000 + 260 / 1.8e-2)) < 0.01, `eta ${p!.etaMs}`);
});

test('laneDepletionForecast: earliest axis wins; respects window_ms override', () => {
  const l = lane({ id: 'codex-cli', requests_per_window: 20, window_ms: W });
  const risingTs = [...spread(6, 95_000, 70_000), ...spread(12, 48_000, 4_000)];
  const events: LedgerEvent[] = risingTs.map((o, i) =>
    taskEvent({ ts: new Date(o.ts).toISOString(), task_id: `f-${i}`, laneId: 'codex-cli' }),
  );
  const f = laneDepletionForecast(events, l, NOW);
  assert.equal(f?.axis, 'window');
  assert.ok(Math.abs((f?.etaMs ?? 0) - (30_000 + 2.6 / 1.8e-4)) < 0.01);
  // No quota config ⇒ no forecast.
  assert.equal(laneDepletionForecast(events, lane({ id: 'codex-cli' }), NOW), undefined);
});

test('laneQuotaState: calibrated floor raises a low-routed lane\'s used', () => {
  const l = lane({ id: 'codex-cli', requests_per_window: 10, window_ms: 2 * HOUR, calibration_fraction: 0.7 });
  // Routed used is 0 (no events). Calibrated floor is 0.7.
  const s = laneQuotaState([], l, NOW);
  assert.ok(s.window);
  assert.ok(Math.abs(s.window.used - 0.7) < 1e-9);
  assert.ok(Math.abs(s.headroom - 0.3) < 1e-9);
});

test('laneQuotaState: routed ABOVE the floor still wins', () => {
  // 8 requests out of 10 limit = 0.8 used. Calibration is 0.3.
  // Routed (0.8) > calibration (0.3).
  const l = lane({ id: 'codex-cli', requests_per_window: 10, window_ms: 2 * HOUR, calibration_fraction: 0.3 });
  const events = Array.from({ length: 8 }, () => taskEvent({ laneId: 'codex-cli' }));
  const s = laneQuotaState(events, l, NOW);
  assert.ok(s.window);
  assert.ok(Math.abs(s.window.used - 0.8) < 1e-9);
  assert.ok(Math.abs(s.headroom - 0.2) < 1e-9);
});

test('laneQuotaState: composition with a reservation on the same lane', () => {
  // Limit = 10, routed = 0, calibration = 0.5, reserve = 0.5.
  // floorUsed = max(0, 0.5) = 0.5.
  // reserve = 0.5 -> mult = 1 / (1 - 0.5) = 2.
  // effectiveUsedFraction = floorUsed * mult = 0.5 * 2 = 1.0.
  const l = lane({ id: 'codex-cli', requests_per_window: 10, window_ms: 2 * HOUR, calibration_fraction: 0.5, reserve_fraction: 0.5 });
  const s = laneQuotaState([], l, NOW);
  assert.ok(s.window);
  assert.ok(Math.abs(s.window.used - 1.0) < 1e-9);
  assert.ok(Math.abs(s.headroom - 0.0) < 1e-9);
});

test('laneQuotaState: reserve=1 and calibration=1 safety', () => {
  // reserve = 1 is clamped to 0.9999 -> mult = 10000.
  // floorUsed = 1.0.
  // used = 10000.
  const l = lane({ id: 'codex-cli', requests_per_window: 10, window_ms: 2 * HOUR, calibration_fraction: 1.0, reserve_fraction: 1.0 });
  const s = laneQuotaState([], l, NOW);
  assert.ok(s.window);
  assert.ok(Number.isFinite(s.window.used));
  assert.ok(Math.abs(s.window.used - 10000) < 1e-6);
  assert.ok(Math.abs(s.headroom - 0.0) < 1e-9); // headroom is floored at 0
});

test('laneQuotaState: absent-calibration byte-identical including used > 1', () => {
  // 15 requests out of 10 limit = 1.5 used. Calibration is absent (0).
  const l = lane({ id: 'codex-cli', requests_per_window: 10, window_ms: 2 * HOUR });
  const events = Array.from({ length: 15 }, () => taskEvent({ laneId: 'codex-cli' }));
  const s = laneQuotaState(events, l, NOW);
  assert.ok(s.window);
  assert.ok(Math.abs(s.window.used - 1.5) < 1e-9);
  assert.ok(Math.abs(s.headroom - 0.0) < 1e-9); // headroom is floored at 0
});

test('computePacePressure and adjustHeadroomForPace pure logic', () => {
  const now = 1000;
  // Case 1: No target
  assert.equal(computePacePressure({ etaMs: 200 }, undefined, now), 0);
  // Case 2: Target in past
  assert.equal(computePacePressure({ etaMs: 200 }, 500, now), 0);
  // Case 3: No forecast
  assert.equal(computePacePressure(undefined, 2000, now), 0);
  // Case 4: ETA is on/after target
  assert.equal(computePacePressure({ etaMs: 1500 }, 2000, now), 0); // etaTime = 2500 >= 2000
  // Case 5: ETA is before target (shortfall exists)
  // total = 2000 - 1000 = 1000.
  // etaMs = 200 -> etaTime = 1200.
  // shortfall = 2000 - 1200 = 800.
  // pressure = 800 / 1000 = 0.8.
  assert.equal(computePacePressure({ etaMs: 200 }, 2000, now), 0.8);

  // adjustHeadroomForPace
  // Case A: No pressure
  assert.equal(adjustHeadroomForPace(0.7, undefined, 2000, now), 0.7);
  // Case B: Some pressure
  assert.equal(adjustHeadroomForPace(0.7, { etaMs: 200 }, 2000, now), 0.0); // 0.7 - 0.8 = -0.1 -> floored at 0
  assert.ok(Math.abs(adjustHeadroomForPace(0.9, { etaMs: 500 }, 2000, now) - 0.4) < 1e-9); // 0.9 - 0.5 = 0.4
});

test('computePacePressure and adjustHeadroomForPace boundary cases', () => {
  const now = 1000;
  // target == now
  assert.equal(computePacePressure({ etaMs: 200 }, now, now), 0);
  // eta == target (etaMs = targetMs - now)
  assert.equal(computePacePressure({ etaMs: 1000 }, 2000, now), 0);

  // NaN values
  assert.equal(computePacePressure({ etaMs: NaN }, 2000, now), 0);
  assert.equal(computePacePressure({ etaMs: 200 }, NaN, now), 0);
  assert.equal(computePacePressure({ etaMs: 200 }, 2000, NaN), 0);

  // +Infinity / -Infinity values
  assert.equal(computePacePressure({ etaMs: Infinity }, 2000, now), 0);
  assert.equal(computePacePressure({ etaMs: -Infinity }, 2000, now), 0);
  assert.equal(computePacePressure({ etaMs: 200 }, Infinity, now), 0);
  assert.equal(computePacePressure({ etaMs: 200 }, -Infinity, now), 0);
  assert.equal(computePacePressure({ etaMs: 200 }, 2000, Infinity), 0);
  assert.equal(computePacePressure({ etaMs: 200 }, 2000, -Infinity), 0);

  // unsafe-large ms (> 2**53)
  const unsafeMs = Number.MAX_SAFE_INTEGER + 10;
  assert.equal(computePacePressure({ etaMs: unsafeMs }, 2000, now), 0);
  assert.equal(computePacePressure({ etaMs: 200 }, unsafeMs, now), 0);
  assert.equal(computePacePressure({ etaMs: 200 }, 2000, unsafeMs), 0);

  // negative etaMs
  assert.equal(computePacePressure({ etaMs: -100 }, 2000, now), 0);

  // adjustHeadroomForPace with invalid/negative headroom
  assert.equal(adjustHeadroomForPace(-0.5, { etaMs: 200 }, 2000, now), 0);
  assert.equal(adjustHeadroomForPace(NaN, { etaMs: 200 }, 2000, now), 0);
  assert.equal(adjustHeadroomForPace(Infinity, { etaMs: 200 }, 2000, now), 0);
  assert.equal(adjustHeadroomForPace(-Infinity, { etaMs: 200 }, 2000, now), 0);
});

test('lane with reserve_fraction or calibration_fraction = NaN -> headroom stays finite', () => {
  const l = lane({
    id: 'test-nan',
    requests_per_window: 10,
    window_ms: 2 * 60 * 60 * 1000,
    reserve_fraction: NaN,
    calibration_fraction: NaN,
  });
  const map = quotaHeadroomMap([], [l], NOW);
  assert.equal(map['test-nan'], 1); // fallback to 1 (full headroom)
});

test('calibration composition direct numeric agreement', () => {
  const windowMs = 120 * 60 * 1000; // 2 hours
  const limit = 20;
  const now = Date.now();
  const l = lane({
    id: 'test-calib-composition',
    requests_per_window: limit,
    window_ms: windowMs,
    calibration_fraction: 0.72,
    reserve_fraction: 0.1,
  });

  // 8 events in the window -> raw used is 8/20 = 40%
  const events = [
    taskEvent({ laneId: 'test-calib-composition', ts: new Date(now - 64 * 60 * 1000).toISOString() }),
    taskEvent({ laneId: 'test-calib-composition', ts: new Date(now - 63 * 60 * 1000).toISOString() }),
    taskEvent({ laneId: 'test-calib-composition', ts: new Date(now - 62 * 60 * 1000).toISOString() }),
    taskEvent({ laneId: 'test-calib-composition', ts: new Date(now - 61 * 60 * 1000).toISOString() }),
    taskEvent({ laneId: 'test-calib-composition', ts: new Date(now - 50 * 60 * 1000).toISOString() }),
    taskEvent({ laneId: 'test-calib-composition', ts: new Date(now - 40 * 60 * 1000).toISOString() }),
    taskEvent({ laneId: 'test-calib-composition', ts: new Date(now - 30 * 60 * 1000).toISOString() }),
    taskEvent({ laneId: 'test-calib-composition', ts: new Date(now - 20 * 60 * 1000).toISOString() }),
  ];

  // 1. Check laneQuotaState used fraction & headroom
  const qState = laneQuotaState(events, l, now);
  assert.ok(qState.window);
  // floorUsed = Math.max(8/20, 0.72) = 0.72
  // used = floorUsed / (1 - 0.1) = 0.8
  assert.ok(Math.abs(qState.window.used - 0.8) < 1e-9);
  assert.ok(Math.abs(qState.headroom - 0.2) < 1e-9);

  // 2. Check laneDepletionForecast starts from the same effective occupancy
  // usable limit = 20 * 0.9 = 18.
  // startingOccupancy = Math.max(8, 14.4) = 14.4.
  // lambda = 8 / windowMs = 8 / 7200000 ms.
  // Remaining headroom = 18 - 14.4 = 3.6.
  // etaMs = 3.6 / lambda = 3.6 * 900000 = 3240000 ms (54 minutes).
  const forecast = laneDepletionForecast(events, l, now);
  assert.ok(forecast);
  assert.equal(forecast.axis, 'window');
  assert.ok(Math.abs(forecast.etaMs - 3240000) < 1e-9);

  // 3. Check quotaHeadroomMap headroom agrees
  const map = quotaHeadroomMap(events, [l], now);
  assert.ok(Math.abs((map['test-calib-composition'] ?? 0) - 0.2) < 1e-9);
});




