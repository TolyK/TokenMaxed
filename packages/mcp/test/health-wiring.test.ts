import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  eligibleLanes,
  evaluate,
  hostAllowsLane,
  modelMatchesPin,
  filterEventsSince,
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

import { makeServerDeps } from '../src/server.ts';
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
function failedTaskEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    event_type: 'task',
    schema_version: SCHEMA_VERSION,
    id: `t-${seq}`,
    seq: seq++,
    ts: new Date(Date.now() - 30_000).toISOString(),
    task_id: `task-${seq}`,
    attempt: 0,
    category: 'bugfix',
    laneId: 'strong',
    model: 'strong-m',
    trust_mode: 'full',
    provenance: 'anthropic',
    status: 'failed',
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
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-health-'));
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
      TOKENMAXED_PROJECT: 'health-test',
    },
  };
}

test('health signal off ⇒ byte-identical preview and no health info printed', async () => {
  const { dir, env } = setupDir([failedTaskEvent()]);
  try {
    const deps = makeServerDeps(env); // lane_health not in env ⇒ off
    const r = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'strong');
    assert.doesNotMatch(r.content[0]!.text, /health/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('health signal on but no failure evidence ⇒ no health info printed', async () => {
  const { dir, env } = setupDir([]); // empty ledger
  try {
    const deps = makeServerDeps({ ...env, TOKENMAXED_LANE_HEALTH: 'true' });
    const r = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'strong');
    assert.doesNotMatch(r.content[0]!.text, /health/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('health signal on, failure evidence exists ⇒ unhealthy lane is deprioritized', async () => {
  // One failed attempt on strong. Cheap will win if strong gets penalized.
  // Health penalty for 1 failure = 1 * 0.2 = 0.2 penalty on strong.
  // strong score = 0.85 (cap) - 0.2 (health) = 0.65.
  // cheap score = 0.6. Strong still wins? Let's check: 0.65 > 0.6, so strong still wins.
  // Wait, let's put 2 failures on strong so errorRate is 1.0 (penalty 0.2). Strong score = 0.65.
  // Wait, strong capability is 0.85, cheap capability is 0.86?
  // Let's modify cheap capability to be 0.7. If strong has penalty 0.2, score is 0.85 - 0.2 = 0.65. Cheap score is 0.7. So cheap wins!
  const customLanesYaml = LANES_YAML.replace('bugfix: 0.6', 'bugfix: 0.7');
  const { dir, env } = setupDir([failedTaskEvent()], customLanesYaml);
  try {
    const deps = makeServerDeps({ ...env, TOKENMAXED_LANE_HEALTH: 'true' });
    const r = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'cheap');
    assert.match(r.content[0]!.text, /health-deprioritized: strong \(health: 1\/1 recent attempts failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('health signal on, repeated failures (3) trips circuit breaker, status shows details', async () => {
  const customLanesYaml = LANES_YAML.replace('bugfix: 0.6', 'bugfix: 0.7');
  const now = Date.now();
  const e1 = failedTaskEvent({ ts: new Date(now - 2 * 60 * 1000).toISOString() });
  const e2 = failedTaskEvent({ ts: new Date(now - 1 * 60 * 1000).toISOString() });
  const e3 = failedTaskEvent({ ts: new Date(now).toISOString() });
  const { dir, env } = setupDir([e1, e2, e3], customLanesYaml);
  try {
    const deps = makeServerDeps({ ...env, TOKENMAXED_LANE_HEALTH: 'true' });
    const r = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'cheap');
    // circuit open retry in ~5m
    assert.match(r.content[0]!.text, /health-deprioritized: strong \(health: 3\/3 recent attempts failed; circuit open, retry in ~5m\)/);

    // Check status tool outputs
    const status = await dispatch(TOOLS, deps, 'router_status', {});
    assert.match(status.content[0]!.text, /Lane Health:/);
    assert.match(status.content[0]!.text, /strong: health: 3\/3 recent attempts failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
