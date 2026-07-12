/**
 * P2 wiring (A1) — the rankings capability-prior overlay in the MCP adapter:
 * the opt-in gate (TOKENMAXED_CAPABILITY_PRIOR), the shared loader
 * (capability-prior-load.ts), fail-open error handling, staleness, and the
 * router_preview surfacing — including the zero-change-when-absent invariant
 * and a real behavior flip driven by the BUNDLED seed snapshot.
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
  resolvedPriorFor,
  routeDecide,
  summarize,
  tokenStats,
  TASK_CATEGORIES,
  classifyTask,
  MIN_CLASSIFY_CONFIDENCE,
  CLASSIFY_FALLBACK_CATEGORY,
  computeSnapshotHash,
} from '../../core/src/index.ts';
import type { CapabilitySnapshot } from '../../core/src/index.ts';

import { MAX_SNAPSHOT_AGE_DAYS, capabilityPriorEnabled, loadCapabilityPriorState } from '../src/capability-prior-load.ts';
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
  resolvedPriorFor,
};
const TOOLS = createTools(CORE);

const PRICES = fileURLToPath(new URL('../prices.seed.json', import.meta.url));
const BUNDLED_SNAPSHOT = fileURLToPath(new URL('../capability-snapshot.v1.json', import.meta.url));

// Two full CLI lanes whose models appear in the BUNDLED seed for `docs`:
// gpt-5.5 → 0.72, claude-sonnet-4-6 → 0.58. Declared: strong 0.70 vs cheap 0.55.
// Flag OFF ⇒ strong wins (0.70 > 0.55). Flag ON ⇒ cheap's prior becomes the
// overlay 0.72 (within the ±0.2 clamp of its 0.55 baseline) ⇒ cheap wins.
const LANES_YAML = `lanes:
  - id: strong
    kind: cli
    model: claude-sonnet-4-6
    command: node
    trust_mode: full
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    capability:
      docs: 0.7
  - id: cheap
    kind: cli
    model: gpt-5.5
    command: node
    trust_mode: full
    costBasis: subscription
    provenance: openai
    jurisdiction: US
    capability:
      docs: 0.55
`;

function fixtureEnv(dir: string, over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TOKENMAXED_LANES: join(dir, 'lanes.yaml'),
    TOKENMAXED_LEDGER: join(dir, 'ledger.jsonl'),
    TOKENMAXED_STATE: join(dir, 'state.json'),
    TOKENMAXED_PRICES: PRICES,
    TOKENMAXED_PROJECT: 'cap-prior-test',
    ...over,
  };
}

function setupDir(over: NodeJS.ProcessEnv = {}): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-capprior-'));
  writeFileSync(join(dir, 'lanes.yaml'), LANES_YAML, 'utf8');
  return { dir, env: fixtureEnv(dir, over) };
}

/** A minimal VALID snapshot (correct hash) with a chosen `generated` date. */
function snapshotFixture(generated: string): CapabilitySnapshot {
  const base = {
    version: 1,
    generated,
    sources: ['test-chart'],
    mapping: { docs: 'test-chart' } as CapabilitySnapshot['mapping'],
    aliases: { 'gpt-5.5': 'gpt-5.5' },
    entries: [
      {
        model: 'gpt-5.5',
        chart: 'test-chart',
        category: 'docs' as const,
        value: 0.72,
        source: 'test-chart',
        date: generated,
        confidence: 'low' as const,
      },
    ],
  };
  return { ...base, hash: computeSnapshotHash(base) };
}

// --- loader gate ---------------------------------------------------------------

test('capabilityPriorEnabled: off by default; kill-switch forces it off', () => {
  assert.equal(capabilityPriorEnabled({}), false);
  assert.equal(capabilityPriorEnabled({ TOKENMAXED_CAPABILITY_PRIOR: 'true' }), true);
  assert.equal(capabilityPriorEnabled({ TOKENMAXED_CAPABILITY_PRIOR: 'true', TOKENMAXED_DISABLE: 'true' }), false);
  assert.equal(capabilityPriorEnabled({ TOKENMAXED_CAPABILITY_PRIOR: 'true', TOKENMAXED_DISABLE: '1' }), false);
});

test('loader: flag off ⇒ state off (no file I/O implied, no overlay)', () => {
  const s = loadCapabilityPriorState({ TOKENMAXED_CAPABILITY_SNAPSHOT: '/nonexistent/nope.json' }, []);
  assert.deepEqual(s, { state: 'off' });
});

test('loader: flag on + missing snapshot ⇒ error state, never throws', () => {
  const s = loadCapabilityPriorState(
    { TOKENMAXED_CAPABILITY_PRIOR: 'true', TOKENMAXED_CAPABILITY_SNAPSHOT: '/nonexistent/nope.json' },
    [],
  );
  assert.equal(s.state, 'error');
  assert.match((s as { warning: string }).warning, /unreadable/);
});

test('loader: flag on + invalid snapshot (bad hash) ⇒ error state with reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-capprior-'));
  try {
    const bad = { ...snapshotFixture('2026-07-01'), hash: 'deadbeef' };
    const p = join(dir, 'snap.json');
    writeFileSync(p, JSON.stringify(bad), 'utf8');
    const s = loadCapabilityPriorState({ TOKENMAXED_CAPABILITY_PRIOR: 'true', TOKENMAXED_CAPABILITY_SNAPSHOT: p }, []);
    assert.equal(s.state, 'error');
    assert.match((s as { warning: string }).warning, /invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loader: fresh vs stale derived from `generated` vs MAX_SNAPSHOT_AGE_DAYS; unparseable ⇒ stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-capprior-'));
  try {
    const now = Date.parse('2026-07-11T00:00:00Z');
    const env = (p: string): NodeJS.ProcessEnv => ({ TOKENMAXED_CAPABILITY_PRIOR: 'true', TOKENMAXED_CAPABILITY_SNAPSHOT: p });

    const freshPath = join(dir, 'fresh.json');
    writeFileSync(freshPath, JSON.stringify(snapshotFixture('2026-07-01')), 'utf8');
    const fresh = loadCapabilityPriorState(env(freshPath), [], { now });
    assert.equal(fresh.state, 'on');
    assert.equal((fresh as { stale: boolean }).stale, false);

    const staleDate = new Date(now - (MAX_SNAPSHOT_AGE_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    const stalePath = join(dir, 'stale.json');
    writeFileSync(stalePath, JSON.stringify(snapshotFixture(staleDate)), 'utf8');
    const stale = loadCapabilityPriorState(env(stalePath), [], { now });
    assert.equal(stale.state, 'on');
    assert.equal((stale as { stale: boolean }).stale, true);

    const badDatePath = join(dir, 'baddate.json');
    writeFileSync(badDatePath, JSON.stringify(snapshotFixture('not-a-date')), 'utf8');
    const badDate = loadCapabilityPriorState(env(badDatePath), [], { now });
    assert.equal(badDate.state, 'on');
    assert.equal((badDate as { stale: boolean }).stale, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loader: bundled seed validates and maps docs/explain with meta populated', () => {
  const s = loadCapabilityPriorState(
    { TOKENMAXED_CAPABILITY_PRIOR: 'true', TOKENMAXED_CAPABILITY_SNAPSHOT: BUNDLED_SNAPSHOT },
    [],
  );
  assert.equal(s.state, 'on');
  const on = s as Extract<typeof s, { state: 'on' }>;
  assert.equal(on.meta.source, 'mercor-apex-v1');
  assert.deepEqual([...on.meta.categories].sort(), ['docs', 'explain']);
});

// --- adapter wiring (makeServerDeps) --------------------------------------------

test('makeServerDeps: flag off ⇒ capabilityPrior dep reports off; preview identical to before (zero-change gate)', async () => {
  const { dir, env } = setupDir();
  try {
    const deps = makeServerDeps(env);
    assert.deepEqual(deps.capabilityPrior?.([]), { state: 'off' });
    const r = await dispatch(TOOLS, deps, 'router_preview', { category: 'docs' });
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'strong');
    assert.doesNotMatch(r.content[0]!.text, /capability prior/);
    assert.equal(r.structuredContent!.capabilityPrior, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeServerDeps: flag on flips the docs pick via the bundled seed, and /why says why', async () => {
  const { dir, env } = setupDir({ TOKENMAXED_CAPABILITY_PRIOR: 'true' });
  try {
    const deps = makeServerDeps(env);
    const r = await dispatch(TOOLS, deps, 'router_preview', { category: 'docs' });
    // cheap (gpt-5.5): overlay 0.72 (fresh seed regenerates staleness from Date.now(),
    // so assert only the ON banner, not fresh/stale) beats strong's declared 0.7.
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'cheap');
    assert.match(r.content[0]!.text, /capability prior: mercor-apex-v1 \(generated 2026-06-20/);
    assert.match(r.content[0]!.text, /prior for "cheap": overlay/);
    const sc = r.structuredContent!.capabilityPrior as { state: string; winnerProvenance?: string };
    assert.equal(sc.state, 'on');
    assert.match(sc.winnerProvenance ?? '', /overlay/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeServerDeps: flag on + broken snapshot path ⇒ routing unaffected, warning surfaced in /why and /status', async () => {
  const { dir, env } = setupDir({
    TOKENMAXED_CAPABILITY_PRIOR: 'true',
    TOKENMAXED_CAPABILITY_SNAPSHOT: join(tmpdir(), 'definitely-missing-snapshot.json'),
  });
  try {
    const deps = makeServerDeps(env);
    const r = await dispatch(TOOLS, deps, 'router_preview', { category: 'docs' });
    // Fail-open: same pick as flag-off.
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'strong');
    assert.match(r.content[0]!.text, /capability prior: ERROR/);
    const st = await dispatch(TOOLS, deps, 'router_status', {});
    assert.match(st.content[0]!.text, /Capability prior: ERROR/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeServerDeps: preview and delegate consume the SAME loader (parity via the dep)', () => {
  const { dir, env } = setupDir({ TOKENMAXED_CAPABILITY_PRIOR: 'true' });
  try {
    const deps = makeServerDeps(env);
    const lanes = deps.candidateLanes('docs');
    const viaDep = deps.capabilityPrior?.(lanes);
    const direct = loadCapabilityPriorState(env, lanes);
    assert.deepEqual(viaDep, direct);
    assert.equal(viaDep?.state, 'on');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('router_status: default-off adds NO capability-prior line (byte-compat guard); on-state adds one', async () => {
  const { dir, env } = setupDir();
  try {
    const off = await dispatch(TOOLS, makeServerDeps(env), 'router_status', {});
    assert.doesNotMatch(off.content[0]!.text, /[Cc]apability prior/);
    const on = await dispatch(
      TOOLS,
      makeServerDeps({ ...env, TOKENMAXED_CAPABILITY_PRIOR: 'true' }),
      'router_status',
      {},
    );
    assert.match(on.content[0]!.text, /Capability prior: ON — mercor-apex-v1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loader: exactly MAX_SNAPSHOT_AGE_DAYS old is NOT stale (boundary is strict >)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-capprior-'));
  try {
    const now = Date.parse('2026-07-11T00:00:00Z');
    const boundaryDate = new Date(now - MAX_SNAPSHOT_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const p = join(dir, 'boundary.json');
    writeFileSync(p, JSON.stringify(snapshotFixture(boundaryDate)), 'utf8');
    const s = loadCapabilityPriorState(
      { TOKENMAXED_CAPABILITY_PRIOR: 'true', TOKENMAXED_CAPABILITY_SNAPSHOT: p },
      [],
      { now },
    );
    assert.equal(s.state, 'on');
    assert.equal((s as { stale: boolean }).stale, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay entries are per-lane independent: a lane\'s prior is identical whatever other lanes load with it', () => {
  // This is the property that makes the escalation lane-set difference between
  // preview (reviewer reserved out) and delegate (full usable set) benign: shared
  // lanes get byte-identical overlay entries, so the pick can never diverge —
  // only the unranked COUNT is scoped to the set (and /why words it that way).
  const { dir, env } = setupDir({ TOKENMAXED_CAPABILITY_PRIOR: 'true' });
  try {
    const deps = makeServerDeps(env);
    const lanes = deps.candidateLanes('docs');
    const cheap = lanes.find((l) => l.id === 'cheap')!;
    const together = loadCapabilityPriorState(env, lanes);
    const alone = loadCapabilityPriorState(env, [cheap]);
    assert.equal(together.state, 'on');
    assert.equal(alone.state, 'on');
    assert.deepEqual(
      (together as Extract<typeof together, { state: 'on' }>).overlay['cheap'],
      (alone as Extract<typeof alone, { state: 'on' }>).overlay['cheap'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- invariants ------------------------------------------------------------------

test('invariant: capability:0 opt-out is never resurrected by the overlay', async () => {
  const { dir, env } = setupDir({ TOKENMAXED_CAPABILITY_PRIOR: 'true' });
  try {
    // cheap (gpt-5.5, overlay 0.72 for docs) opts OUT of docs entirely.
    writeFileSync(
      join(dir, 'lanes.yaml'),
      LANES_YAML.replace('      docs: 0.55', '      docs: 0'),
      'utf8',
    );
    const deps = makeServerDeps(env);
    const r = await dispatch(TOOLS, deps, 'router_preview', { category: 'docs' });
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'strong');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
