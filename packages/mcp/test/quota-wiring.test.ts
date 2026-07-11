/**
 * B2 — quota-pressure wiring: the adapter headroom map (delegate/preview
 * parity via the shared builder), the routing behavior flip, sole-lane
 * still-wins, the preferred-override warning, and zero-change-when-absent.
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
  taskCategories: TASK_CATEGORIES,
  classifyTask,
  MIN_CLASSIFY_CONFIDENCE,
  CLASSIFY_FALLBACK_CATEGORY,
};
const TOOLS = createTools(CORE);

const PRICES = fileURLToPath(new URL('../prices.seed.json', import.meta.url));

/**
 * strong is better on bugfix but carries a tiny 5h window; cheap has no quota.
 * Both lanes are EXECUTABLE fixtures (node -e exits immediately, ignoring the
 * stdin prompt) so the escalation-path test can run a real delegate.
 */
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
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-quota-'));
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
      TOKENMAXED_PROJECT: 'quota-test',
    },
  };
}

test('fresh window: strong wins on capability; no quota text (headroom full)', async () => {
  const { dir, env } = setupDir([]);
  try {
    const r = await dispatch(TOOLS, makeServerDeps(env), 'router_preview', { category: 'bugfix' });
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'strong');
    assert.doesNotMatch(r.content[0]!.text, /quota/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exhausted window flips routing to the unquota\'d lane and names the pressured loser', async () => {
  const { dir, env } = setupDir([taskEvent(), taskEvent()]); // 2/2 ⇒ headroom 0 ⇒ critical penalty
  try {
    const r = await dispatch(TOOLS, makeServerDeps(env), 'router_preview', { category: 'bugfix' });
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'cheap');
    assert.match(r.content[0]!.text, /quota-deprioritized: strong \(routed-share near cap\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a capped SOLE capable lane still wins, with the honest pressure line', async () => {
  const soleYaml = LANES_YAML.replace(/ {2}- id: cheap[\s\S]*$/m, '');
  const { dir, env } = setupDir([taskEvent(), taskEvent()], soleYaml);
  try {
    const r = await dispatch(TOOLS, makeServerDeps(env), 'router_preview', { category: 'bugfix' });
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'strong');
    assert.match(r.content[0]!.text, /quota: 5h 2\/2 routed — pressure applied; it won anyway/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preferred lane overrides quota pressure — loudly', async () => {
  const { dir, env } = setupDir([taskEvent(), taskEvent()]);
  try {
    const deps = makeServerDeps({ ...env, TOKENMAXED_PREFER_LANE: 'strong' });
    const r = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'strong');
    assert.match(r.content[0]!.text, /⚠ preferred lane overrides quota pressure \(5h 2\/2 routed\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity: the deps builder returns exactly the core headroom map delegate routes with', () => {
  const { dir, env } = setupDir([taskEvent()]);
  try {
    const deps = makeServerDeps(env);
    const lanes = deps.candidateLanes('bugfix');
    const viaDep = deps.capHeadroom?.(lanes);
    assert.ok(viaDep);
    assert.ok(Math.abs(viaDep!['strong']! - 0.5) < 1e-9); // 1/2 used
    assert.equal(viaDep!['cheap'], undefined); // no quota config ⇒ omitted
    const direct = quotaHeadroomMap(deps.readLedger(), lanes, Date.now());
    assert.deepEqual(viaDep, direct);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zero-change-when-absent: no quota config ⇒ undefined map AND byte-identical preview output', async () => {
  const noQuotaYaml = LANES_YAML.replace('    requests_per_window: 2\n', '');
  const { dir, env } = setupDir([taskEvent()], noQuotaYaml);
  try {
    const deps = makeServerDeps(env);
    assert.equal(deps.capHeadroom?.(deps.candidateLanes('bugfix')), undefined);
    // Full-output comparison: the same deps with the B2 hooks REMOVED must
    // produce an identical preview result (text and structured content), so the
    // quota feature provably adds nothing when unconfigured.
    const withB2 = await dispatch(TOOLS, deps, 'router_preview', { category: 'bugfix' });
    const withoutB2 = await dispatch(
      TOOLS,
      { ...deps, capHeadroom: undefined, quotaDetail: undefined },
      'router_preview',
      { category: 'bugfix' },
    );
    assert.deepEqual(withB2, withoutB2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('escalation-path outcome also carries the preferred-override note (plan §1.3)', async () => {
  // Escalation enabled: the delegate goes through runWithEscalation. With no
  // reviewer configured the review is unavailable, but the OUTCOME path is the
  // escalation branch — the ⚠ note must not be skipped there. The preferred
  // capped lane wins (override) and the outcome reason carries the warning.
  const { dir, env } = setupDir([taskEvent(), taskEvent()]);
  try {
    const deps = makeServerDeps({ ...env, TOKENMAXED_PREFER_LANE: 'strong', TOKENMAXED_ESCALATE: 'true' });
    const outcome = await deps.delegate({ category: 'bugfix', instruction: 'noop test task' });
    assert.equal(outcome.laneId, 'strong');
    // 3/2: the just-executed leg was recorded before the detail string was read —
    // the note reflects the honest post-execution state.
    assert.match(outcome.reason ?? '', /⚠ preferred lane overrides quota pressure \(5h 3\/2 routed\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- B3/B4: quota alerts + overflow plan -----------------------------------------

test('quotaAlerts: warn/critical lane gets an alert with routed detail and a category-attributed overflow plan', async () => {
  const { dir, env } = setupDir([taskEvent(), taskEvent()]); // strong at 2/2 ⇒ critical
  try {
    const deps = makeServerDeps(env);
    const alerts = await deps.quotaAlerts!();
    assert.equal(alerts.length, 1);
    // Detail + overflow: bugfix (strong's only routed category) re-routes to cheap.
    assert.match(alerts[0]!, /^⚠ strong: 5h 2\/2 routed · overflow: bugfix → cheap$/);
    // router_status renders the alert under the honesty header.
    const st = await dispatch(TOOLS, deps, 'router_status', {});
    assert.match(st.content[0]!.text, /Quota \(routed share only — not your total subscription usage\):/);
    assert.match(st.content[0]!.text, /⚠ strong: 5h 2\/2 routed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quotaAlerts: no capped lane ⇒ no alerts, and status stays silent', async () => {
  const { dir, env } = setupDir([taskEvent()]); // 1/2 ⇒ ok
  try {
    const deps = makeServerDeps(env);
    assert.deepEqual(await deps.quotaAlerts!(), []);
    const st = await dispatch(TOOLS, deps, 'router_status', {});
    assert.doesNotMatch(st.content[0]!.text, /Quota \(routed share/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quotaAlerts: with no alternative lane the overflow honestly says none (host)', async () => {
  const soleYaml = LANES_YAML.replace(/ {2}- id: cheap[\s\S]*$/m, '');
  const { dir, env } = setupDir([taskEvent(), taskEvent()], soleYaml);
  try {
    const alerts = await makeServerDeps(env).quotaAlerts!();
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!, /overflow: bugfix → none \(host\)$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quotaAlerts: a historically-routed category the lane can no longer serve is EXCLUDED from overflow', async () => {
  // strong opted OUT of docs (capability 0) but the ledger carries old docs
  // history; the overflow plan must not advertise docs (plan: "its categories"
  // = currently eligible with positive effective capability).
  const optOutYaml = LANES_YAML.replace('      bugfix: 0.85', '      bugfix: 0.85\n      docs: 0');
  const { dir, env } = setupDir(
    [taskEvent({ category: 'docs' }), taskEvent({ category: 'docs' })], // 2/2 window ⇒ critical
    optOutYaml,
  );
  try {
    const alerts = await makeServerDeps(env).quotaAlerts!();
    assert.equal(alerts.length, 1);
    assert.doesNotMatch(alerts[0]!, /docs/);
    assert.doesNotMatch(alerts[0]!, /overflow/); // no eligible categories remain
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
