/**
 * F — MCP adapter wiring for per-host lane gating: TOKENMAXED_HOST threads from
 * the env into every preview/delegate RouteContext (parity), /tokenmaxed:why
 * names lanes rejected by host scope, and the manager selectors fail closed on
 * an unknown host.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  eligibleLanes,
  SCHEMA_VERSION,
  serializeEvent,
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
} from '../../core/src/index.ts';
import type { Lane, LedgerEvent, Policy, TaskEvent } from '../../core/src/index.ts';

import { hostFromEnv } from '../src/host-id.ts';
import { selectManagerLane } from '../src/manager-select.ts';
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

// The STRONGER lane is scoped to claude-code; the weaker one is unrestricted —
// so the winner flips purely on the host identity.
const LANES_YAML = `lanes:
  - id: scoped-strong
    kind: cli
    model: strong-m
    command: node
    args: ['-e', 'process.stdout.write("done-strong")']
    trust_mode: full
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    hosts: [claude-code]
    capability:
      bugfix: 0.9
  - id: open-weak
    kind: cli
    model: weak-m
    command: node
    args: ['-e', 'process.stdout.write("done-weak")']
    trust_mode: full
    costBasis: subscription
    provenance: openai
    jurisdiction: US
    capability:
      bugfix: 0.6
`;

function setupDir(host?: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-host-'));
  writeFileSync(join(dir, 'lanes.yaml'), LANES_YAML, 'utf8');
  return {
    dir,
    env: {
      TOKENMAXED_LANES: join(dir, 'lanes.yaml'),
      TOKENMAXED_LEDGER: join(dir, 'ledger.jsonl'),
      TOKENMAXED_STATE: join(dir, 'state.json'),
      TOKENMAXED_PRICES: PRICES,
      TOKENMAXED_PROJECT: 'host-test',
      ...(host !== undefined ? { TOKENMAXED_HOST: host } : {}),
    },
  };
}

test('hostFromEnv: trims + lowercases; absent/empty ⇒ undefined', () => {
  assert.equal(hostFromEnv({ TOKENMAXED_HOST: ' Claude-Code ' }), 'claude-code');
  assert.equal(hostFromEnv({ TOKENMAXED_HOST: '' }), undefined);
  assert.equal(hostFromEnv({}), undefined);
});

test('preview under a listed host: the scoped lane wins; no host-blocked line', async () => {
  const { dir, env } = setupDir('claude-code');
  try {
    const r = await dispatch(TOOLS, makeServerDeps(env), 'router_preview', { category: 'bugfix' });
    assert.notEqual(r.isError, true);
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'scoped-strong');
    assert.doesNotMatch(r.content[0]!.text, /host-blocked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preview under a foreign host: the scoped lane is host-blocked and /why says so', async () => {
  const { dir, env } = setupDir('codex-cli');
  try {
    const r = await dispatch(TOOLS, makeServerDeps(env), 'router_preview', { category: 'bugfix' });
    assert.notEqual(r.isError, true);
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'open-weak');
    assert.match(r.content[0]!.text, /host-blocked: scoped-strong .*'codex-cli'/);
    assert.match(r.content[0]!.text, /YOUR acknowledgement/);
    assert.deepEqual(r.structuredContent!.hostBlocked, ['scoped-strong']);
    assert.equal(r.structuredContent!.host, 'codex-cli');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preview with NO host identity: the scoped lane fails closed (never bypassed)', async () => {
  const { dir, env } = setupDir(undefined);
  try {
    const r = await dispatch(TOOLS, makeServerDeps(env), 'router_preview', { category: 'bugfix' });
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'open-weak');
    assert.match(r.content[0]!.text, /host-blocked: scoped-strong .*'unknown'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selectManagerLane: a hosts:-scoped manager is only selected under a listed host', () => {
  const mgr: Lane = {
    id: 'mgr', kind: 'cli', model: 'm', trust_mode: 'full', costBasis: 'subscription',
    provenance: 'anthropic', jurisdiction: 'US', command: 'x',
    roles: ['manager'], manager_allowed: true, hosts: ['claude-code'],
  };
  const policy: Policy = {};
  assert.equal(selectManagerLane([mgr], policy, false, null, 'claude-code')?.id, 'mgr');
  assert.equal(selectManagerLane([mgr], policy, false, null, 'codex-cli'), undefined);
  assert.equal(selectManagerLane([mgr], policy, false, null), undefined); // unknown host fails closed
});

// --- preview/delegate PARITY (the real makeServerDeps, both paths) -------------

for (const [host, expected] of [
  ['claude-code', 'scoped-strong'],
  ['codex-cli', 'open-weak'],
  [undefined, 'open-weak'], // missing identity ⇒ fail closed on both paths
] as const) {
  test(`delegate parity under host=${host ?? '(none)'}: delegate and preview pick "${expected}"`, async () => {
    const { dir, env } = setupDir(host);
    try {
      const deps = makeServerDeps(env);
      const preview = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
      assert.equal((preview.structuredContent!.decision as { laneId: string }).laneId, expected);
      const outcome = await deps.delegate({ category: 'bugfix', instruction: 'noop test task' });
      assert.equal(outcome.laneId, expected);
      assert.notEqual(outcome.native, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- reservedForReview is host-aware (adapter-level) ----------------------------

const MANAGER_LANES_YAML = `lanes:
  - id: scoped-mgr
    kind: cli
    model: mgr-m
    command: node
    args: ['-e', 'process.stdout.write("VERDICT: pass")']
    trust_mode: full
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    hosts: [claude-code]
    roles: [manager]
    manager_allowed: true
    capability:
      bugfix: 0.9
  - id: open-weak
    kind: cli
    model: weak-m
    command: node
    args: ['-e', 'process.stdout.write("done-weak")']
    trust_mode: full
    costBasis: subscription
    provenance: openai
    jurisdiction: US
    capability:
      bugfix: 0.6
`;

function setupManagerDir(host?: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-host-mgr-'));
  writeFileSync(join(dir, 'lanes.yaml'), MANAGER_LANES_YAML, 'utf8');
  return {
    dir,
    env: {
      TOKENMAXED_LANES: join(dir, 'lanes.yaml'),
      TOKENMAXED_LEDGER: join(dir, 'ledger.jsonl'),
      TOKENMAXED_STATE: join(dir, 'state.json'),
      TOKENMAXED_PRICES: PRICES,
      TOKENMAXED_PROJECT: 'host-mgr-test',
      TOKENMAXED_ESCALATE: 'true',
      ...(host !== undefined ? { TOKENMAXED_HOST: host } : {}),
    },
  };
}

test('escalation on, listed host: the manager lane IS reserved (excluded from candidates)', () => {
  const { dir, env } = setupManagerDir('claude-code');
  try {
    const ids = makeServerDeps(env).candidateLanes('bugfix').map((l) => l.id);
    assert.deepEqual(ids, ['open-weak']); // scoped-mgr held back as the reviewer
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('escalation on, foreign host: a host-blocked manager is NOT reserved — and still cannot win', async () => {
  const { dir, env } = setupManagerDir('codex-cli');
  try {
    const deps = makeServerDeps(env);
    // Not reserved (it can't review here), so it stays in the candidate set…
    assert.deepEqual(deps.candidateLanes('bugfix').map((l) => l.id), ['scoped-mgr', 'open-weak']);
    // …but the host gate still keeps it from being SELECTED, in preview and delegate alike.
    const preview = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((preview.structuredContent!.decision as { laneId: string }).laneId, 'open-weak');
    assert.match(preview.content[0]!.text, /host-blocked: scoped-mgr/);
    const outcome = await deps.delegate({ category: 'bugfix', instruction: 'noop test task' });
    assert.equal(outcome.laneId, 'open-weak');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- quota alerts: the overflow plan is host-aware (ctxFor threads the host) ----

// The capped lane is unrestricted; the only overflow target is hosts:-scoped —
// so the overflow winner flips purely on the host identity.
const QUOTA_LANES_YAML = `lanes:
  - id: capped-weak
    kind: cli
    model: weak-m
    command: node
    args: ['-e', 'process.stdout.write("done-weak")']
    trust_mode: full
    costBasis: subscription
    provenance: openai
    jurisdiction: US
    requests_per_window: 2
    capability:
      bugfix: 0.6
  - id: scoped-strong
    kind: cli
    model: strong-m
    command: node
    args: ['-e', 'process.stdout.write("done-strong")']
    trust_mode: full
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    hosts: [claude-code]
    capability:
      bugfix: 0.9
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
    laneId: 'capped-weak',
    model: 'weak-m',
    trust_mode: 'full',
    provenance: 'openai',
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

function setupQuotaDir(host?: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-host-quota-'));
  writeFileSync(join(dir, 'lanes.yaml'), QUOTA_LANES_YAML, 'utf8');
  const events: LedgerEvent[] = [taskEvent(), taskEvent()]; // 2/2 ⇒ critical
  writeFileSync(join(dir, 'ledger.jsonl'), events.map((e) => serializeEvent(e)).join('\n') + '\n', 'utf8');
  return {
    dir,
    env: {
      TOKENMAXED_LANES: join(dir, 'lanes.yaml'),
      TOKENMAXED_LEDGER: join(dir, 'ledger.jsonl'),
      TOKENMAXED_STATE: join(dir, 'state.json'),
      TOKENMAXED_PRICES: PRICES,
      TOKENMAXED_PROJECT: 'host-quota-test',
      ...(host !== undefined ? { TOKENMAXED_HOST: host } : {}),
    },
  };
}

test('quota overflow plan under a listed host: re-routes to the scoped lane', async () => {
  const { dir, env } = setupQuotaDir('claude-code');
  try {
    const alerts = await makeServerDeps(env).quotaAlerts!();
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!, /overflow: bugfix → scoped-strong/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quota overflow plan under a foreign host: the scoped lane is not offered (fail closed)', async () => {
  const { dir, env } = setupQuotaDir('codex-cli');
  try {
    const alerts = await makeServerDeps(env).quotaAlerts!();
    assert.equal(alerts.length, 1);
    assert.doesNotMatch(alerts[0]!, /scoped-strong/);
    assert.match(alerts[0]!, /overflow: bugfix → none \(host\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
