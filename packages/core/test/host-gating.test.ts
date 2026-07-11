import assert from 'node:assert/strict';
import { test } from 'node:test';

import { eligibleLanes, hostAllowsLane, routeDecide } from '../src/route.ts';
import { canReassign, selectEscalationTarget } from '../src/reassign.ts';
import { selectReviewManager } from '../src/review.ts';
import { runWithEscalation } from '../src/run.ts';
import type { EscalationDeps } from '../src/run.ts';
import { parseLaneConfig, LaneConfigError } from '../src/registry.ts';
import type { PriceTable } from '../src/price.ts';
import type { Lane, Policy, RouteContext, Task } from '../src/types.ts';

const lane = (over: Partial<Lane> & { id: string }): Lane => ({
  kind: 'cli', model: 'm', trust_mode: 'full', costBasis: 'subscription',
  provenance: 'anthropic', jurisdiction: 'US', command: 'x', ...over,
});

const open = lane({ id: 'open-lane', provenance: 'openai', capability: { bugfix: 0.8, docs: 0.8 } });
const scoped = lane({ id: 'claude-cli', hosts: ['claude-code', 'cli'], capability: { bugfix: 0.95, docs: 0.95 } });
const task: Task = { category: 'bugfix' };
const noPolicy: Policy = {};

// --- the predicate itself --------------------------------------------------

test('hostAllowsLane: hosts absent ⇒ allowed under any (or no) host', () => {
  assert.equal(hostAllowsLane(open, {}), true);
  assert.equal(hostAllowsLane(open, { host: 'codex-cli' }), true);
});

test('hostAllowsLane: hosts present ⇒ ctx.host must be present AND listed (fail closed)', () => {
  assert.equal(hostAllowsLane(scoped, { host: 'claude-code' }), true);
  assert.equal(hostAllowsLane(scoped, { host: 'cli' }), true);
  assert.equal(hostAllowsLane(scoped, { host: 'codex-cli' }), false);
  assert.equal(hostAllowsLane(scoped, {}), false); // unknown host never bypasses an allowlist
  assert.equal(hostAllowsLane(scoped, { host: '' }), false);
});

// --- initial routing (eligibleLanes / routeDecide) ---------------------------

test('eligibleLanes drops a host-blocked lane; a listed host keeps it', () => {
  const under = (host?: string) =>
    eligibleLanes(task, { lanes: [open, scoped], ...(host ? { host } : {}) }, noPolicy).map((e) => e.lane.id);
  assert.deepEqual(under('claude-code'), ['open-lane', 'claude-cli']);
  assert.deepEqual(under('codex-cli'), ['open-lane']);
  assert.deepEqual(under(undefined), ['open-lane']); // fail closed on missing identity
});

test('a PREFERRED host-blocked lane cannot win', () => {
  const ctx: RouteContext = { lanes: [open, scoped], host: 'codex-cli', preferLaneId: 'claude-cli' };
  assert.equal(routeDecide(task, ctx, noPolicy).laneId, 'open-lane');
});

test('host gating is NOT YOLO-overridable (third-party terms, not the user trust axis)', () => {
  const ctx: RouteContext = { lanes: [open, scoped], host: 'codex-cli', yolo: true };
  const ids = eligibleLanes(task, ctx, noPolicy).map((e) => e.lane.id);
  assert.deepEqual(ids, ['open-lane']);
});

test('hosts-absent lanes with no ctx.host route byte-identically to a hosted ctx', () => {
  const lanes = [open, lane({ id: 'other', provenance: 'google', capability: { bugfix: 0.7 } })];
  const bare = routeDecide(task, { lanes }, noPolicy);
  const hosted = routeDecide(task, { lanes, host: 'opencode' }, noPolicy);
  assert.deepEqual(hosted, bare);
});

// --- reassignment / escalation targets ---------------------------------------

test('a host-blocked lane is never a reassignment/escalation target', () => {
  const ctx: RouteContext = { lanes: [open, scoped], host: 'codex-cli', policyContext: { repo_class: 'public', sensitivity: 'normal' } };
  assert.equal(canReassign(open, scoped, task, ctx, noPolicy), false);
  assert.equal(selectEscalationTarget(open, [open, scoped], task, ctx, noPolicy), null);
  // …and under a listed host the same target is reachable again.
  const allowed: RouteContext = { ...ctx, host: 'claude-code' };
  assert.equal(canReassign(open, scoped, task, allowed, noPolicy), true);
});

// --- manager selection --------------------------------------------------------

test('a host-blocked manager is never selected to review', () => {
  const subject = lane({ id: 'subject', provenance: 'xai', capability: { bugfix: 0.5 } });
  const manager = lane({ id: 'mgr', roles: ['manager'], manager_allowed: true, hosts: ['claude-code'], capability: { bugfix: 0.9 } });
  const ctx: RouteContext = { lanes: [subject, manager], policyContext: { repo_class: 'public', sensitivity: 'normal' } };
  assert.equal(selectReviewManager([subject, manager], subject, 'bugfix', { ...ctx, host: 'claude-code' }, noPolicy)?.id, 'mgr');
  assert.equal(selectReviewManager([subject, manager], subject, 'bugfix', { ...ctx, host: 'codex-cli' }, noPolicy), null);
  assert.equal(selectReviewManager([subject, manager], subject, 'bugfix', ctx, noPolicy), null); // unknown host fails closed
});

// --- same-lane rework preserves the host decision -----------------------------

test('rework re-runs on the SAME hosts-scoped lane under a listed host (decision preserved)', async () => {
  const subject = lane({ id: 'scoped-worker', hosts: ['claude-code'], capability: { docs: 0.9 } });
  const manager = lane({ id: 'mgr', roles: ['manager'], manager_allowed: true, capability: { docs: 0.95 } });
  const ctx: RouteContext = { lanes: [subject], host: 'claude-code', policyContext: { repo_class: 'public', sensitivity: 'normal' } };
  const verdicts = ['VERDICT: needs-rework', 'VERDICT: pass'];
  let runs = 0;
  const table: PriceTable = { schema_version: 1, frontier_model: 'm', models: { m: { inputPer1M: 15, outputPer1M: 75 } } };
  let ids = 0;
  const deps: EscalationDeps = {
    executeTrusted: async (l) => { runs += 1; return { resultText: `out-${l.id}-${runs}` }; },
    executeUntrusted: async () => ({ ok: true, resultText: 'unused' }),
    untrustedLaneDTO: (l) => ({ id: l.id, model: l.model, endpoint: 'https://fake', authHandle: 'h' }),
    scanSecrets: async () => ({ available: true, hasSecret: false }),
    priceTable: table,
    newId: () => `id-${++ids}`,
    runManager: async () => verdicts.shift() ?? 'VERDICT: pass',
  };
  const esc = await runWithEscalation({ category: 'docs', instruction: 'write docs' }, ctx, noPolicy, deps, { candidates: [subject, manager] });
  assert.equal(esc.result.laneId, 'scoped-worker');
  assert.equal(esc.final_action, 'accept_after_rework');
  assert.equal(runs, 2); // initial + rework, both on the scoped lane
});

// --- registry validation -------------------------------------------------------

const yamlLane = (hosts: string) => `lanes:\n  - id: a\n    kind: cli\n    model: m\n    trust_mode: full\n    costBasis: subscription\n    provenance: anthropic\n    jurisdiction: US\n    command: x\n    hosts: ${hosts}\n`;

test('registry: hosts must be a non-empty array of lowercase [a-z0-9-]+ ids', () => {
  assert.deepEqual(parseLaneConfig(yamlLane('[claude-code, cli]')).lanes[0]!.hosts, ['claude-code', 'cli']);
  assert.throws(() => parseLaneConfig(yamlLane('[]')), LaneConfigError);
  assert.throws(() => parseLaneConfig(yamlLane('["Claude Code"]')), LaneConfigError);
  assert.throws(() => parseLaneConfig(yamlLane('[3]')), LaneConfigError);
});

test('registry: a lane\'s hosts array is frozen (no post-load mutation)', () => {
  const l = parseLaneConfig(yamlLane('[claude-code]')).lanes[0]!;
  assert.throws(() => { (l.hosts as string[]).push('codex-cli'); });
});
