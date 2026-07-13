/**
 * target-wiring.test.ts: Tests for target-date continuity MCP wiring and routing.
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
  laneQuotaState,
  laneDepletionForecast,
  laneObservations,
} from '../../core/src/index.ts';
import type { LedgerEvent, TaskEvent } from '../../core/src/index.ts';

import { makeServerDeps, resolveTargetIso } from '../src/server.ts';
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
  - id: lane-a
    kind: cli
    model: model-a
    command: node
    args: ['-e', 'process.stdout.write("a")']
    trust_mode: full
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    requests_per_window: 10
    window_ms: 7200000
    capability:
      bugfix: 1.0
      feature: 1.0
  - id: lane-b
    kind: cli
    model: model-b
    command: node
    args: ['-e', 'process.stdout.write("b")']
    trust_mode: full
    costBasis: subscription
    provenance: openai
    jurisdiction: US
    requests_per_window: 10
    window_ms: 7200000
    capability:
      bugfix: 0.8
      feature: 0
`;

let seq = 0;
function taskEvent(timeMs: number, overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    event_type: 'task',
    schema_version: SCHEMA_VERSION,
    id: `t-${seq}`,
    seq: seq++,
    ts: new Date(timeMs).toISOString(),
    task_id: `task-${seq}`,
    attempt: 0,
    category: 'bugfix',
    laneId: 'lane-a',
    model: 'model-a',
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
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-target-wiring-'));
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
      TOKENMAXED_PROJECT: 'target-test',
    },
  };
}

test('router_set_target tool validates and sets/clears target datetime', async () => {
  const { dir, env } = setupDir([]);
  try {
    const deps = makeServerDeps(env);

    // Past datetime fails
    const pastStr = new Date(Date.now() - 60000).toISOString();
    let r = await dispatch(TOOLS, deps, 'router_set_target', { lane: 'lane-a', until: pastStr });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /Must be in the future/);

    // Bad format fails
    r = await dispatch(TOOLS, deps, 'router_set_target', { lane: 'lane-a', until: 'not-a-date' });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /Invalid ISO datetime string/);

    // Valid future datetime succeeds
    const futureStr = new Date(Date.now() + 3600000).toISOString();
    r = await dispatch(TOOLS, deps, 'router_set_target', { lane: 'lane-a', until: futureStr });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0]!.text, /Target datetime of .* set for: lane-a/);

    // Verify it is listed in status
    let status = await dispatch(TOOLS, deps, 'router_status', {});
    assert.match(status.content[0]!.text, /Pacing targets \(project override\):/);
    assert.match(status.content[0]!.text, new RegExp(`lane-a: target last until ${futureStr}`));

    // Clear target
    r = await dispatch(TOOLS, deps, 'router_set_target', { lane: 'lane-a', until: 'off' });
    assert.equal(r.isError, undefined);
    assert.match(r.content[0]!.text, /Target datetime CLEARED for lane\/model "lane-a"/);

    status = await dispatch(TOOLS, deps, 'router_status', {});
    assert.doesNotMatch(status.content[0]!.text, /Pacing targets/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pacing pressure deprioritizes lane-a so lane-b wins, but lane-a is selected if only capable', async () => {
  const now = Date.now();
  const events: LedgerEvent[] = [
    taskEvent(now - 81 * 60 * 1000),
    taskEvent(now - 80 * 60 * 1000),
    taskEvent(now - 79 * 60 * 1000),
    taskEvent(now - 78 * 60 * 1000),
    taskEvent(now - 50 * 60 * 1000),
    taskEvent(now - 40 * 60 * 1000),
    taskEvent(now - 30 * 60 * 1000),
    taskEvent(now - 20 * 60 * 1000),
  ];

  const { dir, env } = setupDir(events);
  try {
    const deps = makeServerDeps(env);

    // Normally (no target), lane-a wins because of alphabetical tiebreaker
    let route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((route.structuredContent!.decision as { laneId: string }).laneId, 'lane-a');

    // Set target to now + 60 minutes.
    // Projected ETA is now + 30 minutes. 30 < 60 -> ahead of pace!
    // Pacing pressure will deprioritize lane-a, so lane-b wins.
    const targetStr = new Date(now + 60 * 60 * 1000).toISOString();
    await dispatch(TOOLS, deps, 'router_set_target', { lane: 'lane-a', until: targetStr });

    route = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((route.structuredContent!.decision as { laneId: string }).laneId, 'lane-b');

    // Under status, lane-a's quotaDetail should show targeted details
    const status = await dispatch(TOOLS, deps, 'router_status', {});
    assert.match(status.content[0]!.text, /ahead of pace/);
    assert.match(status.content[0]!.text, /conserving/);

    // However, if we request 'feature', only lane-a has capability for it (lane-b doesn't).
    // So lane-a must still be selected (never hard-blocked).
    route = await dispatch(TOOLS, deps, 'router_preview', { category: 'feature' });
    assert.equal((route.structuredContent!.decision as { laneId: string }).laneId, 'lane-a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('specificity-ordered target resolution', () => {
  const laneObj = {
    id: 'claude-opus-cli',
    model: 'claude-3-opus',
  } as any;

  // Exact ID match is preferred
  const targets1 = {
    'claude-opus-cli': '2026-07-15T09:00:00.000Z',
    'claude-3-opus': '2026-07-16T09:00:00.000Z',
    'claude-3': '2026-07-17T09:00:00.000Z',
  };
  assert.equal(resolveTargetIso(laneObj, targets1), '2026-07-15T09:00:00.000Z');

  // Exact model match is preferred over family pin
  const targets2 = {
    'claude-3-opus': '2026-07-16T09:00:00.000Z',
    'claude-3': '2026-07-17T09:00:00.000Z',
  };
  assert.equal(resolveTargetIso(laneObj, targets2), '2026-07-16T09:00:00.000Z');

  // Family pin match works as fallback
  const targets3 = {
    'claude-3': '2026-07-17T09:00:00.000Z',
  };
  assert.equal(resolveTargetIso(laneObj, targets3), '2026-07-17T09:00:00.000Z');
});

test('specificity-ordered family resolution deterministic longest-match key', () => {
  const laneObj = {
    id: 'claude-opus-cli',
    model: 'claude-3-opus',
  } as any;
  const targets = {
    'claude': '2026-07-15T09:00:00.000Z',
    'claude-3': '2026-07-16T09:00:00.000Z',
  };
  // Longest matching key is claude-3, which has length 8 > claude (length 6)
  assert.equal(resolveTargetIso(laneObj, targets), '2026-07-16T09:00:00.000Z');
});

test('validation check boundary cases: non-ISO, malformed ISO, empty-lane + invalid until', async () => {
  const { dir, env } = setupDir([]);
  try {
    const deps = makeServerDeps(env);

    // 1. parseable-but-non-ISO input ("July 15, 2026 09:00")
    let r = await dispatch(TOOLS, deps, 'router_set_target', { lane: 'lane-a', until: 'July 15, 2026 09:00' });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /strict ISO-8601 format/);

    // 2. malformed ISO suffix
    r = await dispatch(TOOLS, deps, 'router_set_target', { lane: 'lane-a', until: '2026-07-15T09:00:00.000Zextra' });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /strict ISO-8601 format/);

    // 3. empty-lane + invalid until (must NOT clear all, should throw validation error instead)
    r = await dispatch(TOOLS, deps, 'router_set_target', { lane: '', until: 'garbage' });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /strict ISO-8601 format/);

    // 4. calendar-invalid date (e.g. Feb 30)
    r = await dispatch(TOOLS, deps, 'router_set_target', { lane: 'lane-a', until: '2026-02-30T09:00:00Z' });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /strict ISO-8601 format/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt target.json values are ignored/dropped on read', async () => {
  const { dir, env } = setupDir([]);
  try {
    const stateFile = env.TOKENMAXED_STATE!;
    const targetFile = join(dirname(stateFile), 'target.json');
    const badState = {
      'target-test': {
        'lane-a': 'July 15, 2026 09:00', // non-ISO
        'lane-b': '2026-07-15T09:00:00.000Zextra', // malformed suffix
        'lane-c': new Date(Date.now() - 60000).toISOString(), // expired (past)
        'lane-d': '2026-02-30T09:00:00Z', // calendar-invalid
      },
    };
    writeFileSync(targetFile, JSON.stringify(badState), 'utf8');

    const deps = makeServerDeps(env);
    const targets = deps.getTargets?.() ?? {};
    assert.deepEqual(targets, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('low-confidence and absent-forecast honesty labels', async () => {
  const now = Date.now();
  // Case A: Absent forecast (0 events)
  const { dir: dirA, env: envA } = setupDir([]);
  try {
    const deps = makeServerDeps(envA);
    const targetStr = new Date(now + 60 * 60 * 1000).toISOString();
    await dispatch(TOOLS, deps, 'router_set_target', { lane: 'lane-a', until: targetStr });

    const allL = deps.allLanes?.() ?? [];
    const laneObj = allL.find((l) => l.id === 'lane-a')!;
    const detail = deps.quotaDetail?.(laneObj);
    assert.match(detail ?? '', /routed-pace forecast unavailable \/ too uncertain to pace/);
    assert.doesNotMatch(detail ?? '', /on pace/);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
  }

  // Case B: Low confidence forecast (span between 30 and 60 mins)
  const eventsB: LedgerEvent[] = [
    taskEvent(now - 65 * 60 * 1000),
    taskEvent(now - 64 * 60 * 1000),
    taskEvent(now - 63 * 60 * 1000),
    taskEvent(now - 62 * 60 * 1000),
    taskEvent(now - 50 * 60 * 1000),
    taskEvent(now - 40 * 60 * 1000),
    taskEvent(now - 30 * 60 * 1000),
    taskEvent(now - 20 * 60 * 1000),
  ];
  const { dir: dirB, env: envB } = setupDir(eventsB);
  try {
    const deps = makeServerDeps(envB);
    const targetStr = new Date(now + 60 * 60 * 1000).toISOString();
    await dispatch(TOOLS, deps, 'router_set_target', { lane: 'lane-a', until: targetStr });

    const allL = deps.allLanes?.() ?? [];
    const laneObj = allL.find((l) => l.id === 'lane-a')!;
    const detail = deps.quotaDetail?.(laneObj);
    assert.match(detail ?? '', /routed-pace forecast unavailable \/ too uncertain to pace/);
    assert.doesNotMatch(detail ?? '', /ahead of pace/);
    assert.doesNotMatch(detail ?? '', /conserving/);
    assert.doesNotMatch(detail ?? '', /early/);
  } finally {
    rmSync(dirB, { recursive: true, force: true });
  }

  // Case C: Low confidence forecast with ETA after target (span < 30 mins)
  const eventsC: LedgerEvent[] = [];
  for (let i = 0; i < 8; i++) {
    eventsC.push(taskEvent(now - (20 - i) * 60 * 1000));
  }
  const { dir: dirC, env: envC } = setupDir(eventsC);
  try {
    const deps = makeServerDeps(envC);
    // target is in 10 minutes (ETA is 30 mins)
    const targetStr = new Date(now + 10 * 60 * 1000).toISOString();
    await dispatch(TOOLS, deps, 'router_set_target', { lane: 'lane-a', until: targetStr });

    const allL = deps.allLanes?.() ?? [];
    const laneObj = allL.find((l) => l.id === 'lane-a')!;
    const detail = deps.quotaDetail?.(laneObj);
    assert.match(detail ?? '', /routed-pace forecast unavailable \/ too uncertain to pace/);
    assert.doesNotMatch(detail ?? '', /on pace/);
    assert.doesNotMatch(detail ?? '', /ahead of pace/);

    // Verify NO pace pressure: headroom should be exactly 0.2 (base headroom)
    const headroomMap = deps.capHeadroom?.(allL);
    assert.ok(Math.abs((headroomMap?.['lane-a'] ?? 0) - 0.2) < 1e-9);
  } finally {
    rmSync(dirC, { recursive: true, force: true });
  }
});
