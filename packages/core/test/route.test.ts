import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSelectablePreGate, routeDecide } from '../src/route.ts';
import { capHeadroom } from '../src/usage.ts';
import type { Lane, Policy, RouteContext, Task } from '../src/types.ts';

const claude: Lane = {
  id: 'claude-native',
  kind: 'cli',
  model: 'claude-opus-4-7',
  trust: 'trusted',
  costBasis: 'subscription',
  provenance: 'anthropic',
  jurisdiction: 'US',
  capability: { feature: 0.95, refactor: 0.9, boilerplate: 0.9, docs: 0.85 },
};

const codex: Lane = {
  id: 'codex-cli',
  kind: 'cli',
  model: 'gpt-5.5',
  trust: 'trusted',
  costBasis: 'subscription',
  provenance: 'openai',
  jurisdiction: 'US',
  capability: { bugfix: 0.92, codegen: 0.9, feature: 0.85 },
};

const ollama: Lane = {
  id: 'ollama-llama3',
  kind: 'local',
  model: 'llama3.1:8b',
  trust: 'trusted',
  costBasis: 'local',
  provenance: 'meta',
  jurisdiction: 'US',
  capability: { boilerplate: 0.7, docs: 0.6, explain: 0.6 },
};

const ctx: RouteContext = { lanes: [claude, codex, ollama] };
const noPolicy: Policy = {};

function decide(category: Task['category'], context = ctx, policy = noPolicy) {
  return routeDecide({ category }, context, policy);
}

test('routes a feature task to the highest-capability lane', () => {
  const d = decide('feature');
  assert.equal(d.laneId, 'claude-native');
  assert.match(d.reason, /claude-native/);
  assert.match(d.reason, /feature/);
});

test('routes a bugfix to Codex (its strongest category) over Claude', () => {
  assert.equal(decide('bugfix').laneId, 'codex-cli');
});

test('is deterministic: identical inputs yield identical decisions', () => {
  const a = decide('refactor');
  const b = decide('refactor');
  assert.deepEqual(a, b);
});

test('prefers the cheaper cost basis when capability is tied', () => {
  // Two lanes equally capable at docs; the local lane (no cost penalty) wins.
  const localDocs: Lane = { ...ollama, id: 'a-local', capability: { docs: 0.8 } };
  const subDocs: Lane = { ...claude, id: 'z-sub', capability: { docs: 0.8 } };
  const d = routeDecide({ category: 'docs' }, { lanes: [subDocs, localDocs] }, noPolicy);
  assert.equal(d.laneId, 'a-local');
});

test('breaks an exact tie deterministically by lane id (ascending)', () => {
  const l1: Lane = { ...ollama, id: 'zzz', capability: { explain: 0.6 } };
  const l2: Lane = { ...ollama, id: 'aaa', capability: { explain: 0.6 } };
  const d = routeDecide({ category: 'explain' }, { lanes: [l1, l2] }, noPolicy);
  assert.equal(d.laneId, 'aaa');
});

test('falls back to the default capability for an unscored category', () => {
  // Only Ollama scores "explain"; the others use DEFAULT_CAPABILITY (0.5).
  // Ollama's 0.6 beats the default 0.5 even though it has no cost penalty advantage here.
  assert.equal(decide('explain').laneId, 'ollama-llama3');
});

test('returns every candidate scored and sorted best-first', () => {
  const d = decide('feature');
  assert.equal(d.scores.length, 3);
  for (let i = 1; i < d.scores.length; i++) {
    assert.ok(d.scores[i - 1]!.score >= d.scores[i]!.score);
  }
});

test('excludes policy-disabled lanes from candidates', () => {
  const d = decide('feature', ctx, { disabledLaneIds: ['claude-native'] });
  assert.notEqual(d.laneId, 'claude-native');
  assert.ok(!d.scores.some((s) => s.laneId === 'claude-native'));
});

test('never selects an untrusted lane, even when it scores highest', () => {
  const cheapUntrusted: Lane = {
    id: 'deepseek-api',
    kind: 'api',
    model: 'deepseek-v3',
    trust: 'untrusted',
    costBasis: 'metered',
    provenance: 'deepseek',
    jurisdiction: 'CN',
    capability: { codegen: 1, bugfix: 1, feature: 1, refactor: 1, boilerplate: 1, docs: 1, explain: 1 },
  };
  const d = routeDecide({ category: 'codegen' }, { lanes: [cheapUntrusted, codex] }, noPolicy);
  assert.equal(d.laneId, 'codex-cli');
  assert.ok(!d.scores.some((s) => s.laneId === 'deepseek-api'));
});

test('never selects an API lane before the gate, even a trusted-labeled one', () => {
  const trustedApi: Lane = {
    id: 'some-api',
    kind: 'api',
    model: 'whatever',
    trust: 'trusted',
    costBasis: 'metered',
    provenance: 'x',
    jurisdiction: 'US',
    capability: { docs: 1 },
  };
  assert.equal(isSelectablePreGate(trustedApi), false);
  const d = routeDecide({ category: 'docs' }, { lanes: [trustedApi, claude] }, noPolicy);
  assert.equal(d.laneId, 'claude-native');
});

test('isSelectablePreGate admits only trusted, non-API lanes', () => {
  assert.equal(isSelectablePreGate(claude), true);
  assert.equal(isSelectablePreGate(codex), true);
  assert.equal(isSelectablePreGate(ollama), true);
});

test('throws when only untrusted/API lanes are available (none selectable pre-gate)', () => {
  const onlyUntrusted: Lane = {
    id: 'u',
    kind: 'api',
    model: 'm',
    trust: 'untrusted',
    costBasis: 'metered',
    provenance: 'p',
    jurisdiction: 'CN',
  };
  assert.throws(
    () => routeDecide({ category: 'feature' }, { lanes: [onlyUntrusted] }, noPolicy),
    /no candidate lanes/,
  );
});

test('deprioritizes a near-cap (warn) lane in favor of an equally-capable healthy one', () => {
  // Two lanes equally capable at docs; the one near its weekly cap loses.
  const a: Lane = { ...codex, id: 'a-warn', capability: { docs: 0.9 } };
  const b: Lane = { ...codex, id: 'b-healthy', capability: { docs: 0.9 } };
  const d = routeDecide(
    { category: 'docs' },
    { lanes: [a, b], capHeadroom: { 'a-warn': 0.2 } }, // 80% used ⇒ warn
    noPolicy,
  );
  assert.equal(d.laneId, 'b-healthy');
  const warnScore = d.scores.find((s) => s.laneId === 'a-warn')!;
  assert.ok(warnScore.factors.capPenalty > 0);
});

test('treats a critical-cap lane as last resort but still selectable when alone', () => {
  const only: Lane = { ...claude, id: 'crit', capability: { feature: 0.95 } };
  const d = routeDecide(
    { category: 'feature' },
    { lanes: [only], capHeadroom: { crit: 0.05 } }, // 95% used ⇒ critical
    noPolicy,
  );
  assert.equal(d.laneId, 'crit');
  assert.equal(d.scores[0]!.factors.capPenalty, 1);

  // Against a healthy lower-capability lane, the critical lane is skipped.
  const healthyWeak: Lane = { ...ollama, id: 'weak', capability: { feature: 0.5 } };
  const d2 = routeDecide(
    { category: 'feature' },
    { lanes: [only, healthyWeak], capHeadroom: { crit: 0.05 } },
    noPolicy,
  );
  assert.equal(d2.laneId, 'weak');
});

test('applies the warn penalty at exactly 70% used, even with float imprecision', () => {
  // capHeadroom(700, 1000) === 0.30000000000000004, which must still count as warn.
  const headroom = capHeadroom(700, 1000);
  const lane: Lane = { ...codex, id: 'edge', capability: { docs: 0.9 } };
  const d = routeDecide({ category: 'docs' }, { lanes: [lane], capHeadroom: { edge: headroom } }, noPolicy);
  assert.ok(d.scores[0]!.factors.capPenalty > 0);
});

test('a lane absent from capHeadroom is treated as having full headroom', () => {
  const d = routeDecide({ category: 'feature' }, { lanes: [claude], capHeadroom: {} }, noPolicy);
  assert.equal(d.scores[0]!.factors.capPenalty, 0);
});

test('throws a clear error when no candidate lanes remain', () => {
  assert.throws(
    () => routeDecide({ category: 'feature' }, { lanes: [] }, noPolicy),
    /no candidate lanes/,
  );
  assert.throws(
    () => decide('feature', ctx, { disabledLaneIds: ['claude-native', 'codex-cli', 'ollama-llama3'] }),
    /no candidate lanes/,
  );
});
