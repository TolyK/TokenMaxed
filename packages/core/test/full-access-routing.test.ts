import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eligibleLanes, routeDecide, isSelectablePreGate, isReaderElevated } from '../src/route.ts';
import { evaluate } from '../src/policy.ts';
import { minimizeForReader } from '../src/minimize.ts';
import type { Lane, Policy, RouteContext, Task } from '../src/types.ts';

// Set up reader lane
const readerLane: Lane = {
  id: 'minimax-api',
  kind: 'api',
  model: 'minimax-m3',
  trust_mode: 'reader',
  costBasis: 'metered',
  provenance: 'minimax',
  jurisdiction: 'CN',
  capability: { feature: 0.9 },
  repo_read_attestation: true
};

const fullLane: Lane = {
  id: 'claude-native',
  kind: 'cli',
  model: 'claude-opus',
  trust_mode: 'full',
  costBasis: 'subscription',
  provenance: 'anthropic',
  jurisdiction: 'US',
  capability: { feature: 0.95 }
};

const workerLane: Lane = {
  id: 'deepseek-api',
  kind: 'api',
  model: 'deepseek-v3',
  trust_mode: 'worker',
  costBasis: 'metered',
  provenance: 'deepseek',
  jurisdiction: 'CN',
  capability: { feature: 0.99 }
};

test('isReaderElevated helper works correctly', () => {
  assert.equal(isReaderElevated(readerLane, ['minimax-api']), true);
  assert.equal(isReaderElevated(readerLane, ['other']), false);
  assert.equal(isReaderElevated(fullLane, ['claude-native']), false); // Only reader
});

test('isSelectablePreGate admits elevated reader even without gateReady/readerEgress/attestation', () => {
  // Normally reader needs gateReady and readerEgress
  assert.equal(isSelectablePreGate(readerLane, false, false, false, false), false);
  // Elevated reader is selectable if certified
  assert.equal(isSelectablePreGate(readerLane, false, false, false, true), true);
});

test('elevated reader is selectable on private/sensitive context', () => {
  const policy: Policy = {};
  const task: Task = { category: 'feature' };
  
  // Normal context: reader is force-trusted away because of hard cap
  const ctxNormal: RouteContext = {
    lanes: [readerLane, fullLane],
    gateReady: true,
    readerEgress: true,
    policyContext: { repo_class: 'private', sensitivity: 'sensitive' }
  };
  
  const normalDecision = routeDecide(task, ctxNormal, policy);
  assert.equal(normalDecision.laneId, 'claude-native'); // Routes to full lane because reader was dropped

  // Elevated context
  const ctxElevated: RouteContext = {
    lanes: [readerLane, fullLane],
    gateReady: true,
    readerEgress: true,
    policyContext: { repo_class: 'private', sensitivity: 'sensitive' },
    fullAccessLaneIds: ['minimax-api']
  };

  const elevatedDecision = routeDecide(task, ctxElevated, policy);
  // minimax-api has higher capability/cost score under minimize than claude-native (or we can tweak capabilities)
  const eligible = eligibleLanes(task, ctxElevated, policy);
  assert.ok(eligible.some(e => e.lane.id === 'minimax-api'));
});

test('elevation of a non-reader is a no-op', () => {
  // worker lane is elevated, but it is not a reader so it shouldn't get elevated
  const ctx: RouteContext = {
    lanes: [workerLane, fullLane],
    gateReady: false, // gate not ready means worker cannot run normally
    fullAccessLaneIds: ['deepseek-api']
  };
  const eligible = eligibleLanes({ category: 'feature' }, ctx, {});
  assert.equal(eligible.some(e => e.lane.id === 'deepseek-api'), false);
});

test('evaluate: reader hard cap is waived when elevated; secretHit still blocks', () => {
  const task: Task = { category: 'feature' };
  const policy: Policy = {};
  
  // Waived: private repo, sensitive, but elevated -> allows
  const contextPrivate = { repo_class: 'private' as const, sensitivity: 'sensitive' as const };
  const decisionPrivate = evaluate(task, readerLane, contextPrivate, policy, true);
  assert.equal(decisionPrivate.verdict, 'force-trusted'); // default baseline is force-trusted.
  
  const policyWithAllow: Policy = {
    rules: [
      { repo_class: 'private', sensitivity: 'sensitive', verdict: 'allow' }
    ]
  };
  const decisionPrivateWithAllow = evaluate(task, readerLane, contextPrivate, policyWithAllow, true);
  // Elevated: skips the reader hard cap, so the allow rule wins!
  assert.equal(decisionPrivateWithAllow.verdict, 'allow');
  
  // Non-elevated: reader hard cap STILL upgrades it to force-trusted
  const decisionPrivateWithAllowNormal = evaluate(task, readerLane, contextPrivate, policyWithAllow, false);
  assert.equal(decisionPrivateWithAllowNormal.verdict, 'force-trusted');

  // secretHit still upgrades allow to force-trusted even when elevated
  const contextSecret = { repo_class: 'public' as const, sensitivity: 'normal' as const, secretHit: true };
  const decisionSecret = evaluate(task, readerLane, contextSecret, policyWithAllow, true);
  assert.equal(decisionSecret.verdict, 'force-trusted');
});

test('minimizeForReader with fullAccess:true passes content verbatim but secret scan still fails closed', async () => {
  const secretHitScanner = async () => ({ available: true, hasSecret: true });
  const noSecretScanner = async () => ({ available: true, hasSecret: false });

  const request = {
    instruction: 'My super secret prompt with credentials and /absolute/path/to/project',
    attachments: [
      { content: 'Some code git@github.com:owner/repo.git', provenance: 'host-authored' as const, repo_derived: true }
    ],
    category: 'feature' as const,
    repo_class: 'private' as const,
    sensitivity: 'sensitive' as const
  };

  // Normal minimizeForReader would block because sensitivity: sensitive
  const resNormal = await minimizeForReader(request, noSecretScanner);
  assert.equal(resNormal.ok, false);

  // Full access minimizeForReader:
  const resFull = await minimizeForReader(request, noSecretScanner, { fullAccess: true });
  assert.equal(resFull.ok, true);
  if (resFull.ok) {
    // Instruction is verbatim (no path scrubbed)
    assert.match(resFull.payload.instruction, /\/absolute\/path/);
    // Attachment is verbatim (no url scrubbed)
    assert.match(resFull.payload.attachments[0]!.content, /git@github\.com/);
  }

  // But secret hit still fails closed even with fullAccess
  const resSecret = await minimizeForReader(request, secretHitScanner, { fullAccess: true });
  assert.equal(resSecret.ok, false);
});

test('eligibleLanes EXCLUDES an elevated reader when policyContext.secretHit === true', () => {
  const policy: Policy = {};
  const task: Task = { category: 'feature' };
  const ctx: RouteContext = {
    lanes: [readerLane, fullLane],
    gateReady: true,
    readerEgress: true,
    policyContext: { repo_class: 'public', sensitivity: 'normal', secretHit: true },
    fullAccessLaneIds: ['minimax-api']
  };
  const eligible = eligibleLanes(task, ctx, policy);
  assert.equal(eligible.some((e) => e.lane.id === 'minimax-api'), false);
});

test('an explicit policy block rule still drops an elevated reader', () => {
  const policy: Policy = {
    rules: [
      { verdict: 'block' }
    ]
  };
  const task: Task = { category: 'feature' };
  const ctx: RouteContext = {
    lanes: [readerLane, fullLane],
    gateReady: true,
    readerEgress: true,
    policyContext: { repo_class: 'public', sensitivity: 'normal' },
    fullAccessLaneIds: ['minimax-api']
  };
  const eligible = eligibleLanes(task, ctx, policy);
  assert.equal(eligible.some((e) => e.lane.id === 'minimax-api'), false);
});

test('a disabledLaneIds entry still drops an elevated reader', () => {
  const policy: Policy = {
    disabledLaneIds: ['minimax-api']
  };
  const task: Task = { category: 'feature' };
  const ctx: RouteContext = {
    lanes: [readerLane, fullLane],
    gateReady: true,
    readerEgress: true,
    policyContext: { repo_class: 'public', sensitivity: 'normal' },
    fullAccessLaneIds: ['minimax-api']
  };
  const eligible = eligibleLanes(task, ctx, policy);
  assert.equal(eligible.some((e) => e.lane.id === 'minimax-api'), false);
});

test('exact-match grant scoping: stored grant of one lane id does not elevate different reader sharing model family prefix', () => {
  const anotherReader: Lane = {
    id: 'minimax-cheap-api',
    kind: 'api',
    model: 'minimax-m3-cheap',
    trust_mode: 'reader',
    costBasis: 'metered',
    provenance: 'minimax',
    jurisdiction: 'CN',
    capability: { feature: 0.8 },
    repo_read_attestation: true
  };
  const ctx: RouteContext = {
    lanes: [readerLane, anotherReader],
    gateReady: true,
    readerEgress: true,
    fullAccessLaneIds: ['minimax-api']
  };
  assert.equal(isReaderElevated(readerLane, ctx.fullAccessLaneIds), true);
  assert.equal(isReaderElevated(anotherReader, ctx.fullAccessLaneIds), false);
});

test('eligibleLanes EXCLUDES an elevated reader when policyContext.secretHit === true and yolo === true', () => {
  const policy: Policy = {};
  const task: Task = { category: 'feature' };
  const ctx: RouteContext = {
    lanes: [readerLane, fullLane],
    gateReady: true,
    readerEgress: true,
    yolo: true,
    policyContext: { repo_class: 'public', sensitivity: 'normal', secretHit: true },
    fullAccessLaneIds: ['minimax-api']
  };
  const eligible = eligibleLanes(task, ctx, policy);
  assert.equal(eligible.some((e) => e.lane.id === 'minimax-api'), false);
});

test('core YOLO: reader is elevated, worker is not, and secretHit still blocks', () => {
  const policy: Policy = {};
  const task: Task = { category: 'feature' };
  const ctx: RouteContext = {
    lanes: [readerLane, workerLane, fullLane],
    gateReady: true,
    readerEgress: true,
    yolo: true,
    policyContext: { repo_class: 'private', sensitivity: 'sensitive' },
    fullAccessLaneIds: ['minimax-api']
  };
  assert.equal(isReaderElevated(readerLane, ctx.fullAccessLaneIds), true);
  assert.equal(isReaderElevated(workerLane, ctx.fullAccessLaneIds), false);

  const eligible = eligibleLanes(task, ctx, policy);
  assert.ok(eligible.some(e => e.lane.id === 'minimax-api'));

  // Under secret hit, even with yolo, it should exclude the elevated reader
  const ctxSecret: RouteContext = {
    ...ctx,
    policyContext: { ...ctx.policyContext, secretHit: true }
  };
  const eligibleSecret = eligibleLanes(task, ctxSecret, policy);
  assert.equal(eligibleSecret.some(e => e.lane.id === 'minimax-api'), false);
});
