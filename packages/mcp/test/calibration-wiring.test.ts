/**
 * calibration-wiring.test.ts: Tests for the manual quota calibration adapter/tool wiring.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  eligibleLanes,
  evaluate,
  hostAllowsLane,
  modelMatchesPin,
  filterEventsSince,
  quotaHeadroomMap,
  laneQuotaState,
  routeDecide,
  summarize,
  tokenStats,
  TASK_CATEGORIES,
  classifyTask,
  MIN_CLASSIFY_CONFIDENCE,
  CLASSIFY_FALLBACK_CATEGORY,
  SCHEMA_VERSION,
  serializeEvent,
} from '../../core/src/index.ts';
import type { LedgerEvent, TaskEvent } from '../../core/src/index.ts';

import { makeServerDeps, resolveCalibrationFraction } from '../src/server.ts';
import { createTools, dispatch } from '../src/tools.ts';
import type { CorePort } from '../src/tools.ts';

const CORE: CorePort = {
  filterEventsSince,
  summarize,
  tokenStats,
  routeDecide,
  eligibleLanes,
  evaluate,
  hostAllowsLane,
  modelMatchesPin,
  taskCategories: TASK_CATEGORIES,
  classifyTask,
  MIN_CLASSIFY_CONFIDENCE,
  CLASSIFY_FALLBACK_CATEGORY,
  laneQuotaState,
  assessDeprecation: () => ({ status: 'ok' }),
  resolveDeprecatedModel: (l: any) => ({ lane: l }),
};
const TOOLS = createTools(CORE);

const PRICES = fileURLToPath(new URL('../prices.seed.json', import.meta.url));

const LANES_YAML = `lanes:
  - id: strong
    kind: cli
    model: strong-m
    command: node
    args: ['-e', 'process.stdout.write("done-strong")']
    trust_mode: full
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    requests_per_window: 2
    capability:
      bugfix: 0.85
  - id: cheap
    kind: cli
    model: cheap-m
    command: node
    args: ['-e', 'process.stdout.write("done-cheap")']
    trust_mode: full
    costBasis: subscription
    provenance: openai
    jurisdiction: US
    capability:
      bugfix: 0.6
`;

let seq = 0;
function taskEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    event_type: 'task',
    schema_version: SCHEMA_VERSION,
    id: `t-${seq}`,
    seq: seq++,
    ts: new Date(Date.now() - 60_000).toISOString(),
    task_id: `task-${seq}`,
    attempt: 0,
    category: 'bugfix',
    laneId: 'strong',
    model: 'strong-m',
    trust_mode: 'full',
    provenance: 'anthropic',
    status: 'ok',
    tokens_in: 100,
    tokens_out: 50,
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

function setupDir(events: readonly LedgerEvent[], lanesYaml = LANES_YAML): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-calibration-wiring-'));
  writeFileSync(join(dir, 'lanes.yaml'), lanesYaml, 'utf8');
  if (events.length > 0) {
    writeFileSync(join(dir, 'ledger.jsonl'), events.map((e) => serializeEvent(e)).join('\n') + '\n', 'utf8');
  }
  return {
    dir,
    env: {
      TOKENMAXED_LANES: join(dir, 'lanes.yaml'),
      TOKENMAXED_LEDGER: join(dir, 'ledger.jsonl'),
      TOKENMAXED_STATE: join(dir, 'state.json'),
      TOKENMAXED_PRICES: PRICES,
      TOKENMAXED_PROJECT: 'calibration-test',
    },
  };
}

test('router_set_calibration tool parses percent and decimal, validates, and gets listed in status', async () => {
  const { dir, env } = setupDir([taskEvent()]);
  try {
    const deps = makeServerDeps(env);

    // Set 70% calibration using percent format
    let r = await dispatch(TOOLS, deps, 'router_set_calibration', { lane: 'strong', fraction: '70%' });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0]!.text, /Manual quota calibration of 70% set for: strong/);

    // Verify it is returned in status honestly
    let status = await dispatch(TOOLS, deps, 'router_status', {});
    assert.match(status.content[0]!.text, /Manual quota calibrations \(project override\):/);
    assert.match(status.content[0]!.text, /strong: calibrated \(you reported 70% used\)/);

    // Set 0.50 calibration using decimal format
    r = await dispatch(TOOLS, deps, 'router_set_calibration', { lane: 'strong', fraction: '0.50' });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0]!.text, /Manual quota calibration of 50% set for: strong/);

    status = await dispatch(TOOLS, deps, 'router_status', {});
    assert.match(status.content[0]!.text, /strong: calibrated \(you reported 50% used\)/);

    // Clear calibration
    r = await dispatch(TOOLS, deps, 'router_set_calibration', { lane: 'strong', fraction: 'off' });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0]!.text, /Manual quota calibration CLEARED for lane\/model "strong"/);

    status = await dispatch(TOOLS, deps, 'router_status', {});
    assert.doesNotMatch(status.content[0]!.text, /Manual quota calibrations/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('calibration floor deprioritizes a lane, and clearing restores normal', async () => {
  // Setup with no task events (usage = 0)
  const { dir, env } = setupDir([]);
  try {
    const deps = makeServerDeps(env);

    // Normally, strong wins
    let route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((route.structuredContent!.decision as { laneId: string }).laneId, 'strong');

    // Calibrate strong to 90% (critical pressure)
    await dispatch(TOOLS, deps, 'router_set_calibration', { lane: 'strong', fraction: '90%' });

    route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    // strong is now at 90% used (calibrated floor), so it loses to cheap
    assert.equal((route.structuredContent!.decision as { laneId: string }).laneId, 'cheap');
    assert.match(route.content[0]!.text, /quota-deprioritized: strong/);

    // Clear calibration, strong wins again
    await dispatch(TOOLS, deps, 'router_set_calibration', { lane: 'strong', fraction: 'off' });

    route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((route.structuredContent!.decision as { laneId: string }).laneId, 'strong');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('routed usage above the calibrated floor still wins (max, not replace)', async () => {
  // Case 1: routed-dominant (5 requests on limit 5 => 100% routed, calibration 30%)
  const customLanesYaml = LANES_YAML.replace('requests_per_window: 2', 'requests_per_window: 5');
  const { dir, env } = setupDir([taskEvent(), taskEvent(), taskEvent(), taskEvent(), taskEvent()], customLanesYaml);
  try {
    const deps = makeServerDeps(env);

    // Calibrate strong to 30% used
    await dispatch(TOOLS, deps, 'router_set_calibration', { lane: 'strong', fraction: '30%' });

    // The routed usage is 100% which is above the calibrated 30% floor.
    // In quota detail / alerts, it should NOT print "calibrated:" and must be categorized under the routed heading.
    const status = await dispatch(TOOLS, deps, 'router_status', {});
    const statusText = status.content[0]!.text;
    assert.match(statusText, /Quota \(routed share only — not your total subscription usage\):/);
    assert.doesNotMatch(statusText, /Quota \(based on your manual calibrations\):/);
    assert.match(statusText, /strong: 5h 5\/5 routed/);

    // Assert /why label is routed-dominant
    const route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.match(route.content[0]!.text, /quota-deprioritized: strong \(routed-share near cap\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Case 2: calibration-dominant (0 requests on limit 2 => 0% routed, calibration 90%)
  const { dir: dir2, env: env2 } = setupDir([taskEvent({ laneId: 'cheap', model: 'cheap-m' })]);
  try {
    const deps = makeServerDeps(env2);

    // Calibrate strong to 90% used
    await dispatch(TOOLS, deps, 'router_set_calibration', { lane: 'strong', fraction: '90%' });

    const status = await dispatch(TOOLS, deps, 'router_status', {});
    const statusText = status.content[0]!.text;
    assert.match(statusText, /Quota \(based on your manual calibrations\):/);
    assert.doesNotMatch(statusText, /Quota \(routed share only — not your total subscription usage\):/);
    assert.match(statusText, /strong: 5h calibrated: you reported 90% used/);

    // Assert /why label is calibration-dominant
    const route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.match(route.content[0]!.text, /quota-deprioritized: strong \(you reported ~90% used\)/);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }

  // Case 3: MIXED-axis (window: 80% routed vs 75% calibration; weekRequests: 40% routed vs 75% calibration)
  const mixedLanesYaml = LANES_YAML.replace(
    'requests_per_window: 2',
    'requests_per_window: 5\n    requests_per_week: 10'
  );
  const { dir: dir3, env: env3 } = setupDir(
    [
      taskEvent({ ts: new Date(Date.now() - 3600 * 1000).toISOString() }),
      taskEvent({ ts: new Date(Date.now() - 3600 * 1000).toISOString() }),
      taskEvent({ ts: new Date(Date.now() - 3600 * 1000).toISOString() }),
      taskEvent({ ts: new Date(Date.now() - 3600 * 1000).toISOString() }),
    ],
    mixedLanesYaml
  );
  try {
    const deps = makeServerDeps(env3);

    // Calibrate strong to 75% used
    await dispatch(TOOLS, deps, 'router_set_calibration', { lane: 'strong', fraction: '75%' });

    const status = await dispatch(TOOLS, deps, 'router_status', {});
    const statusText = status.content[0]!.text;
    
    // It must appear split across BOTH headings!
    assert.match(statusText, /Quota \(routed share only — not your total subscription usage\):/);
    assert.match(statusText, /Quota \(based on your manual calibrations\):/);
    
    // Each with only its relevant axis!
    assert.match(statusText, /strong: 5h 4\/5 routed/);
    assert.match(statusText, /strong: 7d calibrated: you reported 75% used \(routed share 4\/10 req\)/);
  } finally {
    rmSync(dir3, { recursive: true, force: true });
  }

  // Case 4: limiting axis by maximum unbounded used value (routed-derived axis at 200% wins over calibration-derived axis at 110%)
  const doubleMixedLanesYaml = LANES_YAML.replace(
    'requests_per_window: 2',
    'requests_per_window: 5\n    requests_per_week: 10'
  );
  // 10 events in the week, but 0 in the window (6 hours ago)
  const events10 = [];
  for (let i = 0; i < 10; i++) {
    events10.push(taskEvent({
      id: `t-mixed-${i}`,
      task_id: `task-mixed-${i}`,
      ts: new Date(Date.now() - 6 * 3600 * 1000).toISOString()
    }));
  }
  const { dir: dir4, env: env4 } = setupDir(events10, doubleMixedLanesYaml);
  try {
    const deps = makeServerDeps(env4);

    // Set reserve to 50%
    await dispatch(TOOLS, deps, 'router_set_reserve', { lane: 'strong', fraction: '50%' });

    // Calibrate strong to 55% used (valid <= 100%)
    const r = await dispatch(TOOLS, deps, 'router_set_calibration', { lane: 'strong', fraction: '55%' });
    assert.ok(!r.isError);

    // Assert /why label is routed-dominant ("routed-share") and not "you reported"
    const route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    const whyText = route.content[0]!.text;
    assert.match(whyText, /quota-deprioritized: strong \(routed-share near cap\)/);
    assert.doesNotMatch(whyText, /you reported/);

    // ALSO assert the status partition puts the calibration-derived axis under the manual-calibration heading
    // and the routed-derived axis under the routed heading
    const status = await dispatch(TOOLS, deps, 'router_status', {});
    const statusText = status.content[0]!.text;
    assert.match(statusText, /Quota \(routed share only — not your total subscription usage\):/);
    assert.match(statusText, /Quota \(based on your manual calibrations\):/);
    assert.match(statusText, /strong: 7d reserved 50% — 10\/5 req usable routed/);
    assert.match(statusText, /strong: 5h calibrated: you reported 55% used \(reserved 50% — routed share 0\/3 usable\)/);
  } finally {
    rmSync(dir4, { recursive: true, force: true });
  }
});

test('strict [0,1] validation on read/write drops/rejects bad values', async () => {
  const { dir, env } = setupDir([]);
  try {
    const stateFile = env.TOKENMAXED_STATE!;
    const calibrationFile = join(dirname(stateFile), 'calibration.json');
    // Write out-of-range value directly to the calibration overrides file
    const badState = {
      'calibration-test': {
        strong: 2.0,
        cheap: -0.5,
        other: 'garbage',
        valid: 0.7,
      },
    };
    writeFileSync(calibrationFile, JSON.stringify(badState), 'utf8');

    const deps = makeServerDeps(env);
    const calibrations = deps.getCalibrations?.() ?? {};
    // Only the valid one should remain
    assert.deepEqual(calibrations, { valid: 0.7 });

    const status = await dispatch(TOOLS, deps, 'router_status', {});
    assert.match(status.content[0]!.text, /valid: calibrated \(you reported 70% used\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('specificity-ordered resolution: exact lane id beats model beats family', () => {
  const laneObj = {
    id: 'claude-opus-cli',
    model: 'claude-3-opus',
  } as any;

  // Exact ID override is preferred
  const cal1 = {
    'claude-opus-cli': 0.15,
    'claude-3-opus': 0.25,
    'claude-3': 0.35,
  };
  assert.equal(resolveCalibrationFraction(laneObj, cal1), 0.15);

  // Exact ID override wins even when added after a model entry (reversed JSON order)
  const calReversed = {
    'claude-3-opus': 0.25,
    'claude-opus-cli': 0.15,
  };
  assert.equal(resolveCalibrationFraction(laneObj, calReversed), 0.15);

  // Exact model override is preferred over family pin
  const cal2 = {
    'claude-3-opus': 0.25,
    'claude-3': 0.35,
  };
  assert.equal(resolveCalibrationFraction(laneObj, cal2), 0.25);

  // Family pin override works as fallback
  const cal3 = {
    'claude-3': 0.35,
  };
  assert.equal(resolveCalibrationFraction(laneObj, cal3), 0.35);
});

test('composes correctly with a reservation on the same lane', async () => {
  // Limit = 2, routed usage = 0.
  // Calibration = 50% (0.5).
  // Reserve = 50% (0.5).
  // Math: floorUsed = max(0, 0.5) = 0.5.
  // reserve = 0.5 -> mult = 1 / (1 - 0.5) = 2.
  // used = floorUsed * mult = 0.5 * 2 = 1.0 (clamped to [0, 1] => 1.0, critical!).
  // Since used is 1.0 (critical), it triggers quota pressure and deprioritizes strong.
  const { dir, env } = setupDir([]);
  try {
    const deps = makeServerDeps(env);

    await dispatch(TOOLS, deps, 'router_set_calibration', { lane: 'strong', fraction: '50%' });
    await dispatch(TOOLS, deps, 'router_set_reserve', { lane: 'strong', fraction: '50%' });

    // With effectiveUsedFraction = 100%, cheap should win
    let route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((route.structuredContent!.decision as { laneId: string }).laneId, 'cheap');
    assert.match(route.content[0]!.text, /quota-deprioritized: strong/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('byte-identical when absent', async () => {
  const { dir, env } = setupDir([taskEvent()]);
  try {
    // When calibration is absent, the behavior should be identical to raw routed quota.
    const deps = makeServerDeps(env);
    
    // Status should not mention calibration at all
    const status = await dispatch(TOOLS, deps, 'router_status', {});
    assert.doesNotMatch(status.content[0]!.text, /calibrated/);
    assert.doesNotMatch(status.content[0]!.text, /Manual quota calibrations/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('router_set_calibration strictly validates fraction format', async () => {
  const { dir, env } = setupDir([]);
  try {
    const deps = makeServerDeps(env);

    for (const bad of ['70%junk', '0.7oops', '70cats', '-1', '1.01', '150%']) {
      const r = await dispatch(TOOLS, deps, 'router_set_calibration', { lane: 'strong', fraction: bad });
      assert.equal(r.isError, true);
      assert.match(r.content[0]!.text, /Invalid/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
