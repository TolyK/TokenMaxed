/**
 * reserve-wiring.test.ts: Tests for the capacity reservation adapter/tool wiring.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

import { makeServerDeps, resolveReserveFraction } from '../src/server.ts';
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
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-reserve-wiring-'));
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
      TOKENMAXED_PROJECT: 'reserve-test',
    },
  };
}

test('router_set_reserve tool parses percent and decimal, validates, and gets listed in status', async () => {
  const { dir, env } = setupDir([taskEvent()]);
  try {
    const deps = makeServerDeps(env);

    // Set 15% reservation using percent format
    let r = await dispatch(TOOLS, deps, 'router_set_reserve', { lane: 'strong', fraction: '15%' });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0]!.text, /Capacity reservation of 15% set for: strong/);

    // Verify it is returned in status
    let status = await dispatch(TOOLS, deps, 'router_status', {});
    assert.match(status.content[0]!.text, /Capacity reservations \(project override\):/);
    assert.match(status.content[0]!.text, /strong: reserved 15%/);

    // Set 0.40 reservation using decimal format
    r = await dispatch(TOOLS, deps, 'router_set_reserve', { lane: 'strong', fraction: '0.40' });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0]!.text, /Capacity reservation of 40% set for: strong/);

    status = await dispatch(TOOLS, deps, 'router_status', {});
    assert.match(status.content[0]!.text, /strong: reserved 40%/);

    // Clear reservation
    r = await dispatch(TOOLS, deps, 'router_set_reserve', { lane: 'strong', fraction: 'off' });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0]!.text, /Capacity reservation CLEARED for lane\/model "strong"/);

    status = await dispatch(TOOLS, deps, 'router_status', {});
    assert.doesNotMatch(status.content[0]!.text, /Capacity reservations/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reservation deprioritizes earlier and flips routing, and clearing restores normal', async () => {
  // Setup with 1 task event in strong (limit is 2)
  const { dir, env } = setupDir([taskEvent()]);
  try {
    const deps = makeServerDeps(env);

    // Normally (no reservation), strong wins
    let route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((route.structuredContent!.decision as { laneId: string }).laneId, 'strong');

    // Set 60% reservation on strong.
    // 1 used of 2 limit. reserve_fraction = 0.6 -> usable limit = 2 * 0.4 = 0.8.
    // 1 used is > 0.8 usable limit. So used fraction = 1 / 0.8 = 1.25 (critical).
    // This flips routing to cheap.
    await dispatch(TOOLS, deps, 'router_set_reserve', { lane: 'strong', fraction: '60%' });

    route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((route.structuredContent!.decision as { laneId: string }).laneId, 'cheap');
    assert.match(route.content[0]!.text, /quota-deprioritized: strong \(routed-share near cap\)/);

    // Clear reservation, strong wins again
    await dispatch(TOOLS, deps, 'router_set_reserve', { lane: 'strong', fraction: 'off' });

    route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((route.structuredContent!.decision as { laneId: string }).laneId, 'strong');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime override beats config reserve_fraction', async () => {
  // Lanes config has a reserve_fraction: 0.10.
  // With 1 used of 2 limit, 10% reserve -> usable limit = 2 * 0.9 = 1.8.
  // 1 used is ok (< 1.8). Strong wins.
  const customLanesYaml = LANES_YAML.replace('requests_per_window: 2', 'requests_per_window: 2\n    reserve_fraction: 0.10');
  const { dir, env } = setupDir([taskEvent()], customLanesYaml);
  try {
    const deps = makeServerDeps(env);

    // Initially, config reserve_fraction 10% is active. strong wins.
    let route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((route.structuredContent!.decision as { laneId: string }).laneId, 'strong');

    // Override at runtime to 60%. Used fraction becomes critical. cheap wins.
    await dispatch(TOOLS, deps, 'router_set_reserve', { lane: 'strong', fraction: '60%' });
    route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((route.structuredContent!.decision as { laneId: string }).laneId, 'cheap');

    // Override at runtime to 0% (or clear it to fallback to config 10%). strong wins.
    await dispatch(TOOLS, deps, 'router_set_reserve', { lane: 'strong', fraction: '0%' });
    route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((route.structuredContent!.decision as { laneId: string }).laneId, 'strong');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fix 1: out-of-range reserve.json values are ignored/dropped', async () => {
  const { dir, env } = setupDir([taskEvent()]);
  try {
    const stateFile = env.TOKENMAXED_STATE!;
    const reserveFile = join(dirname(stateFile), 'reserve.json');
    // Write out-of-range value directly to the reserve overrides file
    const badState = {
      'reserve-test': {
        strong: 2.0,
        cheap: -0.5,
        other: 'garbage',
      },
    };
    writeFileSync(reserveFile, JSON.stringify(badState), 'utf8');

    const deps = makeServerDeps(env);
    const reserves = deps.getReserves?.() ?? {};
    assert.deepEqual(reserves, {});

    const status = await dispatch(TOOLS, deps, 'router_status', {});
    assert.doesNotMatch(status.content[0]!.text, /Capacity reservations/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fix 3: overrides resolved by specificity precedence', () => {
  const laneObj = {
    id: 'claude-opus-cli',
    model: 'claude-3-opus',
  } as any;

  // Exact ID override is preferred
  const res1 = {
    'claude-opus-cli': 0.1,
    'claude-3-opus': 0.2,
    'claude-3': 0.3,
  };
  assert.equal(resolveReserveFraction(laneObj, res1), 0.1);

  // Exact model override is preferred over family pin
  const res2 = {
    'claude-3-opus': 0.2,
    'claude-3': 0.3,
  };
  assert.equal(resolveReserveFraction(laneObj, res2), 0.2);

  // Family pin override works as fallback
  const res3 = {
    'claude-3': 0.3,
  };
  assert.equal(resolveReserveFraction(laneObj, res3), 0.3);
});

test('Fix 4: router_set_reserve strictly validates fraction format', async () => {
  const { dir, env } = setupDir([]);
  try {
    const deps = makeServerDeps(env);

    for (const bad of ['15%junk', '0.4oops', '15cats', '-1', '1.01', '150%']) {
      const r = await dispatch(TOOLS, deps, 'router_set_reserve', { lane: 'strong', fraction: bad });
      assert.equal(r.isError, true);
      assert.match(r.content[0]!.text, /Invalid/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
