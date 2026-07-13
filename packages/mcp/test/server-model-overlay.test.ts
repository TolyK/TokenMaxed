/**
 * P6 Phase 1c — MCP adapter tests for the model-keyed F-1 overlay: the
 * learn-enabled gate in makeServerDeps (buildObservedByModel) and ledger-driven
 * aggregation wired into router_preview via observedCapabilityByModel.
 */

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
  outcomeCapability,
  routeDecide,
  summarize,
  tokenStats,
  TASK_CATEGORIES,
  classifyTask,
  MIN_CLASSIFY_CONFIDENCE,
  CLASSIFY_FALLBACK_CATEGORY,
  SCHEMA_VERSION,
  serializeEvent,
  capabilityInterval,
  evidenceFreshnessDays,
  resolveLaneModelKey,
  declaredCapabilityFor,
  effectiveCapabilityFor,
} from '../../core/src/index.ts';
import type { LedgerEvent, OutcomeEvent } from '../../core/src/index.ts';

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
  capabilityInterval,
  evidenceFreshnessDays,
  resolveLaneModelKey,
  declaredCapabilityFor,
  effectiveCapabilityFor,
};
const TOOLS = createTools(CORE);

const PRICES = fileURLToPath(new URL('../prices.seed.json', import.meta.url));

const LANES_YAML = `lanes:
  - id: strong
    kind: cli
    model: strong-m
    command: node
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
    trust_mode: full
    costBasis: subscription
    provenance: meta
    jurisdiction: US
    capability:
      bugfix: 0.6
`;

let seq = 0;
function outcome(overrides: Partial<OutcomeEvent> = {}): OutcomeEvent {
  return {
    event_type: 'outcome',
    schema_version: SCHEMA_VERSION,
    id: `o-${seq}`,
    seq: seq++,
    ts: new Date().toISOString(),
    subject_id: 't-0',
    subject_type: 'router_task',
    task_id: 't-0',
    review_id: 'r-0',
    attempt: 0,
    category: 'bugfix',
    subject_lane_id: 'codex-cli',
    subject_provenance: 'openai',
    subject_model: 'cheap-m',
    subject_model_resolved: 'cheap-m',
    reviewer_lane_id: 'claude-native',
    reviewer_model: 'claude-opus-4-7',
    reviewer_trust_mode: 'full',
    reviewer_provenance: 'anthropic',
    verdict: 'pass',
    voter: 'reviewer_model',
    policy_verdict: 'allow',
    ...overrides,
  };
}

// Fixtures use wall-clock timestamps and makeServerDeps decays against its OWN
// Date.now(), so a slow runner (CI) shaves ~1e-9..1e-5 off the decay-weighted
// counts between fixture creation and assertion. 1e-3 tolerates minutes of
// scheduler pause while still catching any real aggregation error.
function near(actual: number, expected: number, eps = 1e-3): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} ≈ ${expected}`);
}

function writeLedger(path: string, events: readonly LedgerEvent[]): void {
  writeFileSync(path, events.map((e) => serializeEvent(e)).join('\n') + '\n', 'utf8');
}

function fixtureEnv(dir: string, learn = false): NodeJS.ProcessEnv {
  return {
    TOKENMAXED_LANES: join(dir, 'lanes.yaml'),
    TOKENMAXED_LEDGER: join(dir, 'ledger.jsonl'),
    TOKENMAXED_STATE: join(dir, 'state.json'),
    TOKENMAXED_PRICES: PRICES,
    TOKENMAXED_GATE_READY: 'true',
    TOKENMAXED_PROJECT: 'overlay-test',
    ...(learn ? { TOKENMAXED_LEARN_CAPABILITY: 'true' } : {}),
  };
}

function setupDir(learn: boolean): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-overlay-'));
  writeFileSync(join(dir, 'lanes.yaml'), LANES_YAML, 'utf8');
  return { dir, env: fixtureEnv(dir, learn) };
}

test('makeServerDeps: learn off leaves observedCapabilityByModel absent (zero-change gate)', () => {
  const { dir, env } = setupDir(false);
  try {
    writeLedger(join(dir, 'ledger.jsonl'), [outcome()]);
    const deps = makeServerDeps(env);
    assert.equal(deps.observedCapabilityByModel?.(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeServerDeps: learn on aggregates verdicts by model across lanes; legacy rows excluded', () => {
  const { dir, env } = setupDir(true);
  try {
    writeLedger(join(dir, 'ledger.jsonl'), [
      outcome({
        task_id: 'a',
        subject_id: 'a',
        subject_lane_id: 'lane-a',
        subject_model: 'shared-m',
        subject_model_resolved: 'shared-m',
        verdict: 'pass',
      }),
      outcome({
        task_id: 'b',
        subject_id: 'b',
        subject_lane_id: 'lane-b',
        subject_model: 'shared-m',
        subject_model_resolved: 'shared-m',
        verdict: 'fail',
      }),
      outcome({
        task_id: 'legacy',
        subject_id: 'legacy',
        subject_lane_id: 'legacy-lane',
        subject_model: undefined,
        subject_model_resolved: undefined,
        verdict: 'pass',
      }),
    ]);
    const deps = makeServerDeps(env);
    const overlay = deps.observedCapabilityByModel?.();
    assert.ok(overlay);
    near(overlay!['shared-m']!.bugfix!.rate, 0.5);
    near(overlay!['shared-m']!.bugfix!.n, 2);
    assert.equal(overlay!['legacy-lane'], undefined);
    assert.equal(Object.keys(overlay!).length, 1);
    const fromLedger = outcomeCapability(deps.readLedger(), Date.now());
    near(fromLedger['shared-m']!.bugfix!.rate, overlay!['shared-m']!.bugfix!.rate);
    near(fromLedger['shared-m']!.bugfix!.n, overlay!['shared-m']!.bugfix!.n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeServerDeps: router_preview threads the ledger-built model overlay when learn is on', async () => {
  const { dir, env } = setupDir(true);
  try {
    const events: OutcomeEvent[] = [];
    for (let i = 0; i < 30; i++) {
      events.push(
        outcome({
          task_id: `t-${i}`,
          subject_id: `t-${i}`,
          subject_lane_id: i % 2 === 0 ? 'lane-a' : 'lane-b',
          subject_model: 'cheap-m',
          subject_model_resolved: 'cheap-m',
          verdict: 'pass',
        }),
      );
    }
    writeLedger(join(dir, 'ledger.jsonl'), events);
    const deps = makeServerDeps(env);
    const on = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((on.structuredContent!.decision as { laneId: string }).laneId, 'cheap');
    assert.match(on.content[0]!.text, /learned/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeServerDeps: learn off keeps preview on declared scores even with ledger evidence', async () => {
  const { dir, env } = setupDir(false);
  try {
    const events: OutcomeEvent[] = [];
    for (let i = 0; i < 30; i++) {
      events.push(
        outcome({
          task_id: `t-${i}`,
          subject_id: `t-${i}`,
          subject_lane_id: 'lane-a',
          subject_model: 'cheap-m',
          subject_model_resolved: 'cheap-m',
          verdict: 'pass',
        }),
      );
    }
    writeLedger(join(dir, 'ledger.jsonl'), events);
    const deps = makeServerDeps(env);
    const r = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'strong');
    assert.doesNotMatch(r.content[0]!.text, /learned/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});