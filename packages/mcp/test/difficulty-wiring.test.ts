/**
 * P6 §4 (A2) — MCP adapter wiring for difficulty-conditioned routing: the
 * learn-gated difficulty overlay builder in makeServerDeps, the router_preview
 * `difficulty` arg (parity with a difficulty-tagged delegate), the schema
 * additions, and the zero-change-when-untagged invariant.
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
import type { DifficultyBucket, LedgerEvent, OutcomeEvent } from '../../core/src/index.ts';

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
    provenance: openai
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
    subject_lane_id: 'x',
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

function writeLedger(path: string, events: readonly LedgerEvent[]): void {
  writeFileSync(path, events.map((e) => serializeEvent(e)).join('\n') + '\n', 'utf8');
}

function setupDir(learn: boolean): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-diff-'));
  writeFileSync(join(dir, 'lanes.yaml'), LANES_YAML, 'utf8');
  return {
    dir,
    env: {
      TOKENMAXED_LANES: join(dir, 'lanes.yaml'),
      TOKENMAXED_LEDGER: join(dir, 'ledger.jsonl'),
      TOKENMAXED_STATE: join(dir, 'state.json'),
      TOKENMAXED_PRICES: PRICES,
      TOKENMAXED_PROJECT: 'diff-test',
      ...(learn ? { TOKENMAXED_LEARN_CAPABILITY: 'true' } : {}),
    },
  };
}

/**
 * A ledger where both models have IDENTICAL category-level records (rate 0.5,
 * n 30) but opposite difficulty mixes: cheap-m passes hard and fails easy;
 * strong-m passes easy and fails hard. So the untagged pick is unchanged by
 * learning symmetry, while a hard-tagged task must flip to cheap.
 */
function mixedLedger(): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const add = (model: string, difficulty: DifficultyBucket, verdict: 'pass' | 'fail', i: number): void => {
    events.push(
      outcome({
        task_id: `${model}-${difficulty}-${i}`,
        subject_id: `${model}-${difficulty}-${i}`,
        subject_model: model,
        subject_model_resolved: model,
        difficulty,
        verdict,
      }),
    );
  };
  for (let i = 0; i < 15; i++) {
    add('cheap-m', 'hard', 'pass', i);
    add('cheap-m', 'easy', 'fail', i);
    add('strong-m', 'hard', 'fail', i);
    add('strong-m', 'easy', 'pass', i);
  }
  return events;
}

test('makeServerDeps: learn off leaves the difficulty overlay absent (zero-change gate)', () => {
  const { dir, env } = setupDir(false);
  try {
    writeLedger(join(dir, 'ledger.jsonl'), [outcome({ difficulty: 'hard' })]);
    const deps = makeServerDeps(env);
    assert.equal(deps.observedCapabilityByModelDifficulty?.(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeServerDeps: learn on builds difficulty cells from the ledger', () => {
  const { dir, env } = setupDir(true);
  try {
    writeLedger(join(dir, 'ledger.jsonl'), mixedLedger());
    const overlay = makeServerDeps(env).observedCapabilityByModelDifficulty?.();
    assert.ok(overlay);
    assert.ok((overlay!['cheap-m']?.bugfix?.hard?.rate ?? 0) > 0.99);
    assert.ok((overlay!['strong-m']?.bugfix?.hard?.rate ?? 1) < 0.01);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('router_preview: hard-tagged preview flips to the hard-passer; untagged pick is unchanged', async () => {
  const { dir, env } = setupDir(true);
  try {
    writeLedger(join(dir, 'ledger.jsonl'), mixedLedger());
    const deps = makeServerDeps(env);
    const untagged = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((untagged.structuredContent!.decision as { laneId: string }).laneId, 'strong');
    assert.doesNotMatch(untagged.content[0]!.text, /difficulty:/);
    const hard = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix', difficulty: 'hard' });
    assert.equal((hard.structuredContent!.decision as { laneId: string }).laneId, 'cheap');
    assert.match(hard.content[0]!.text, /difficulty: hard/);
    assert.equal(hard.structuredContent!.difficulty, 'hard');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('router_preview: difficulty arg without learned evidence changes nothing (fail-open ladder)', async () => {
  const { dir, env } = setupDir(false);
  try {
    const deps = makeServerDeps(env);
    const hard = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix', difficulty: 'hard' });
    assert.equal((hard.structuredContent!.decision as { laneId: string }).laneId, 'strong');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schemas: router_delegate and router_preview accept the optional difficulty enum', () => {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  for (const name of ['router_delegate', 'router_preview']) {
    const schema = byName.get(name)!.inputSchema as { properties: Record<string, { enum?: string[] }>; required?: string[] };
    assert.deepEqual(schema.properties.difficulty?.enum, ['easy', 'moderate', 'hard'], `${name} difficulty enum`);
    assert.ok(!(schema.required ?? []).includes('difficulty'), `${name} difficulty must stay optional`);
  }
});
