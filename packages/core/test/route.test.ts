import assert from 'node:assert/strict';
import { test } from 'node:test';

import { executionModeOf, isManagerEligible, isSelectablePreGate, routeDecide } from '../src/route.ts';
import { capHeadroom } from '../src/usage.ts';
import type { Lane, Policy, RouteContext, Task } from '../src/types.ts';

const claude: Lane = {
  id: 'claude-native',
  kind: 'cli',
  model: 'claude-opus-4-7',
  trust_mode: 'full',
  costBasis: 'subscription',
  provenance: 'anthropic',
  jurisdiction: 'US',
  capability: { feature: 0.95, refactor: 0.9, boilerplate: 0.9, docs: 0.85 },
};

const codex: Lane = {
  id: 'codex-cli',
  kind: 'cli',
  model: 'gpt-5.5',
  trust_mode: 'full',
  costBasis: 'subscription',
  provenance: 'openai',
  jurisdiction: 'US',
  capability: { bugfix: 0.92, codegen: 0.9, feature: 0.85 },
};

const ollama: Lane = {
  id: 'ollama-llama3',
  kind: 'local',
  model: 'llama3.1:8b',
  trust_mode: 'full',
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

test('availability: excludes a configured-but-unavailable lane (the cost winner)', () => {
  // Reproduces the reported bug: a free local lane wins on cost for a tied
  // category — but with availability supplied and the local lane absent from it,
  // the next capable available lane (the subscription CLI) wins instead.
  const localDocs: Lane = { ...ollama, id: 'a-local', capability: { docs: 0.8 } };
  const subDocs: Lane = { ...claude, id: 'z-sub', capability: { docs: 0.8 } };
  const lanes = [subDocs, localDocs];
  // Sanity: without availability, the local lane wins on cost.
  assert.equal(routeDecide({ category: 'docs' }, { lanes }, noPolicy).laneId, 'a-local');
  // With availability listing only the subscription lane, it wins.
  const d = routeDecide({ category: 'docs' }, { lanes, availableLaneIds: ['z-sub'] }, noPolicy);
  assert.equal(d.laneId, 'z-sub');
});

test('availability: an empty available set with no native lane leaves no candidate', () => {
  assert.throws(
    () => routeDecide({ category: 'docs' }, { lanes: [claude, ollama], availableLaneIds: [] }, noPolicy),
    /no candidate lanes available/,
  );
});

test('availability: the native lane is exempt (always runnable) even if not listed', () => {
  const host: Lane = { ...claude, id: 'host', native: true, capability: { docs: 0.5 } };
  // host is NOT in availableLaneIds, yet remains selectable as the only candidate.
  const d = routeDecide({ category: 'docs' }, { lanes: [host, ollama], availableLaneIds: [] }, noPolicy);
  assert.equal(d.laneId, 'host');
});

test('availability: absent set is a no-op (back-compat) — local cost winner still wins', () => {
  const localDocs: Lane = { ...ollama, id: 'a-local', capability: { docs: 0.8 } };
  const subDocs: Lane = { ...claude, id: 'z-sub', capability: { docs: 0.8 } };
  assert.equal(routeDecide({ category: 'docs' }, { lanes: [subDocs, localDocs] }, noPolicy).laneId, 'a-local');
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

test('never selects a worker lane before the gate, even when it scores highest', () => {
  const cheapWorker: Lane = {
    id: 'deepseek-api',
    kind: 'api',
    model: 'deepseek-v3',
    trust_mode: 'worker',
    costBasis: 'metered',
    provenance: 'deepseek',
    jurisdiction: 'CN',
    capability: { codegen: 1, bugfix: 1, feature: 1, refactor: 1, boilerplate: 1, docs: 1, explain: 1 },
  };
  const d = routeDecide({ category: 'codegen' }, { lanes: [cheapWorker, codex] }, noPolicy);
  assert.equal(d.laneId, 'codex-cli');
  assert.ok(!d.scores.some((s) => s.laneId === 'deepseek-api'));
});

test('never selects an API lane before the gate, even a full-trust one', () => {
  const fullApi: Lane = {
    id: 'some-api',
    kind: 'api',
    model: 'whatever',
    trust_mode: 'full',
    costBasis: 'metered',
    provenance: 'x',
    jurisdiction: 'US',
    capability: { docs: 1 },
  };
  assert.equal(isSelectablePreGate(fullApi), false);
  const d = routeDecide({ category: 'docs' }, { lanes: [fullApi, claude] }, noPolicy);
  assert.equal(d.laneId, 'claude-native');
  // But once the gate is ready, a full (user-approved) API lane IS selectable.
  assert.equal(isSelectablePreGate(fullApi, true), true);
});

test('isSelectablePreGate admits only full, non-API lanes while the gate is not ready', () => {
  assert.equal(isSelectablePreGate(claude), true);
  assert.equal(isSelectablePreGate(codex), true);
  assert.equal(isSelectablePreGate(ollama), true);
  const worker: Lane = { ...ollama, id: 'w', trust_mode: 'worker' }; // ollama is kind 'local'
  // A local worker has no certified executor ⇒ never admitted by this guard.
  assert.equal(isSelectablePreGate(worker), false);
  assert.equal(isSelectablePreGate(worker, true), false);
  // An api worker has a certified executor ⇒ admitted once the gate is ready.
  const apiWorker: Lane = { ...ollama, id: 'wa', kind: 'api', trust_mode: 'worker' };
  assert.equal(isSelectablePreGate(apiWorker), false); // gate not ready
  assert.equal(isSelectablePreGate(apiWorker, true), true); // gate ready + certified
  const blocked: Lane = { ...ollama, id: 'b', trust_mode: 'blocked' };
  assert.equal(isSelectablePreGate(blocked, true), false); // blocked never runs
  // reader (F-2) is HIGH-FRICTION: needs gate + readerEgress + API cert + attestation.
  const readerApi: Lane = { ...ollama, id: 'rd', kind: 'api', trust_mode: 'reader', repo_read_attestation: true };
  assert.equal(isSelectablePreGate(readerApi, true), false); // readerEgress off ⇒ no
  assert.equal(isSelectablePreGate(readerApi, false, true), false); // gate off ⇒ no
  assert.equal(isSelectablePreGate({ ...readerApi, repo_read_attestation: false }, true, true), false); // no attestation ⇒ no
  assert.equal(isSelectablePreGate({ ...readerApi, kind: 'cli', command: 'x' }, true, true), false); // CLI not certified (API-only v1)
  assert.equal(isSelectablePreGate(readerApi, true, true), true); // all four ⇒ selectable
  // Fail-closed: a legacy/unknown trust_mode reaching a direct JS caller (not via
  // config normalization) must NOT fall through to the full-lane branch.
  const legacyCli = { ...ollama, id: 'legacy-cli', trust_mode: 'monitored' as unknown as Lane['trust_mode'] };
  const legacyApi = { ...ollama, id: 'legacy-api', kind: 'api' as const, trust_mode: 'monitored' as unknown as Lane['trust_mode'] };
  assert.equal(isSelectablePreGate(legacyCli, true), false);
  assert.equal(isSelectablePreGate(legacyApi, true), false);
});

test('routeDecide: workers stay excluded until policy+cert; full API relaxes only post-gate', () => {
  const worker: Lane = { ...ollama, id: 'worker-lane', kind: 'api', trust_mode: 'worker', capability: { docs: 0.99 } };
  // Worker excluded regardless of gateReady (no minimization/policy/cert yet).
  assert.equal(routeDecide({ category: 'docs' }, { lanes: [worker, claude] }, noPolicy).laneId, 'claude-native');
  assert.equal(
    routeDecide({ category: 'docs' }, { lanes: [worker, claude], gateReady: true }, noPolicy).laneId,
    'claude-native',
  );
  // A FULL (trusted) API lane is excluded pre-gate, selectable post-gate.
  const fullApi: Lane = { ...claude, id: 'full-api', kind: 'api', capability: { docs: 0.99 } };
  assert.equal(routeDecide({ category: 'docs' }, { lanes: [fullApi, claude] }, noPolicy).laneId, 'claude-native');
  assert.equal(
    routeDecide({ category: 'docs' }, { lanes: [fullApi, claude], gateReady: true }, noPolicy).laneId,
    'full-api',
  );
});

test('throws when only untrusted/API lanes are available (none selectable pre-gate)', () => {
  const onlyUntrusted: Lane = {
    id: 'u',
    kind: 'api',
    model: 'm',
    trust_mode: 'worker',
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

test('isManagerEligible requires full trust + manager_allowed + trusted-origin/attestation', () => {
  // Full + manager_allowed + first-party provenance ⇒ eligible.
  assert.equal(isManagerEligible({ ...claude, manager_allowed: true }), true);
  // Local lane (Ollama) is trusted-by-origin.
  assert.equal(isManagerEligible({ ...ollama, manager_allowed: true }), true);
  // manager_allowed not set ⇒ not eligible.
  assert.equal(isManagerEligible(claude), false);
  // A BYOK/non-first-party lane set full+manager_allowed is NOT eligible without attestation.
  const byok: Lane = {
    id: 'byok', kind: 'api', model: 'm', trust_mode: 'full', costBasis: 'metered',
    provenance: 'acme-byok', jurisdiction: 'US', manager_allowed: true,
  };
  assert.equal(isManagerEligible(byok), false);
  assert.equal(isManagerEligible({ ...byok, attestation: true }), true);
  // A worker lane is never manager-eligible.
  assert.equal(isManagerEligible({ ...byok, trust_mode: 'worker', attestation: true }), false);
});

test('executionModeOf defaults to answer-only', () => {
  assert.equal(executionModeOf(claude), 'answer-only');
  assert.equal(executionModeOf({ ...claude, execution_mode: 'agentic' }), 'agentic');
});

test('routeDecide excludes a lane blocked by a policy rule', () => {
  // Block codex for bugfix; claude should win instead.
  const policy: Policy = { rules: [{ provenance: 'openai', category: 'bugfix', verdict: 'block' }] };
  const ctx2: RouteContext = { lanes: [claude, codex], policyContext: { repo_class: 'public', sensitivity: 'normal' } };
  const d = routeDecide({ category: 'bugfix' }, ctx2, policy);
  assert.notEqual(d.laneId, 'codex-cli');
  assert.ok(!d.scores.some((s) => s.laneId === 'codex-cli'));
});

test('routeDecide sets the chosen lane policy verdict', () => {
  // public+normal ⇒ allow.
  const allowCtx: RouteContext = { lanes: [claude], policyContext: { repo_class: 'public', sensitivity: 'normal' } };
  assert.equal(routeDecide({ category: 'feature' }, allowCtx, noPolicy).policyVerdict, 'allow');
  // unknown context ⇒ deny-by-default force-trusted (full lane still allowed).
  assert.equal(routeDecide({ category: 'feature' }, { lanes: [claude] }, noPolicy).policyVerdict, 'force-trusted');
});

test('worker (api) is selectable once gate ready + certified + policy allows; layered otherwise', () => {
  const worker: Lane = { ...ollama, id: 'w-api', kind: 'api', trust_mode: 'worker', capability: { docs: 0.99 } };
  // gate ready + certified executor + public/normal policy ⇒ worker admitted and wins on capability.
  assert.equal(
    routeDecide(
      { category: 'docs' },
      { lanes: [worker, claude], gateReady: true, policyContext: { repo_class: 'public', sensitivity: 'normal' } },
      noPolicy,
    ).laneId,
    'w-api',
  );
  // Unknown context ⇒ policy force-trusted ⇒ worker dropped (defense in depth).
  assert.equal(
    routeDecide({ category: 'docs' }, { lanes: [worker, claude], gateReady: true }, noPolicy).laneId,
    'claude-native',
  );
  // Gate not ready ⇒ worker excluded regardless of policy.
  assert.equal(
    routeDecide(
      { category: 'docs' },
      { lanes: [worker, claude], policyContext: { repo_class: 'public', sensitivity: 'normal' } },
      noPolicy,
    ).laneId,
    'claude-native',
  );
});
