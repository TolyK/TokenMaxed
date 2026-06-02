import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluate,
  laneAllowedByVerdict,
  parsePolicyConfig,
  PolicyConfigError,
} from '../src/policy.ts';
import { loadPolicyConfig } from '../src/node.ts';
import type { Lane, Policy, PolicyContext, Task } from '../src/types.ts';

const fullLane: Lane = {
  id: 'claude', kind: 'cli', model: 'claude-opus-4-7', trust_mode: 'full',
  costBasis: 'subscription', provenance: 'anthropic', jurisdiction: 'US',
};
const workerLane: Lane = {
  id: 'ds', kind: 'api', model: 'deepseek-v3', trust_mode: 'worker',
  costBasis: 'metered', provenance: 'deepseek', jurisdiction: 'CN',
};
const task: Task = { category: 'bugfix' };
const noRules: Policy = {};

test('deny-by-default: unknown context ⇒ force-trusted', () => {
  assert.equal(evaluate(task, workerLane, {}, noRules).verdict, 'force-trusted');
});

test('public + normal sensitivity ⇒ allow (the one clearly-safe baseline)', () => {
  const ctx: PolicyContext = { repo_class: 'public', sensitivity: 'normal' };
  assert.equal(evaluate(task, workerLane, ctx, noRules).verdict, 'allow');
});

test('private repo (no rule) ⇒ force-trusted by default', () => {
  assert.equal(evaluate(task, workerLane, { repo_class: 'private', sensitivity: 'normal' }, noRules).verdict, 'force-trusted');
});

test('a detected secret forces trusted/local only', () => {
  const ctx: PolicyContext = { repo_class: 'public', sensitivity: 'normal', secretHit: true };
  const d = evaluate(task, workerLane, ctx, noRules);
  assert.equal(d.verdict, 'force-trusted');
  assert.match(d.reason, /secret/);
});

test('a secret overrides a matching allow rule (never allow), but a block stays block', () => {
  const ctx: PolicyContext = { repo_class: 'public', sensitivity: 'normal', secretHit: true };
  // An allow rule matches first, but the secret upgrades it to force-trusted.
  const allowPolicy: Policy = { rules: [{ repo_class: 'public', verdict: 'allow' }] };
  assert.equal(evaluate(task, workerLane, ctx, allowPolicy).verdict, 'force-trusted');
  // A stricter block rule is preserved (secret only tightens).
  const blockPolicy: Policy = { rules: [{ repo_class: 'public', verdict: 'block' }] };
  assert.equal(evaluate(task, workerLane, ctx, blockPolicy).verdict, 'block');
});

test('first matching ordered rule wins', () => {
  const policy: Policy = {
    rules: [
      { repo_class: 'public', trust_mode: 'worker', verdict: 'block', reason: 'no workers here' },
      { verdict: 'allow' },
    ],
  };
  const ctx: PolicyContext = { repo_class: 'public', sensitivity: 'normal' };
  assert.equal(evaluate(task, workerLane, ctx, policy).verdict, 'block');
  // The full lane does not match the worker rule ⇒ falls through to allow.
  assert.equal(evaluate(task, fullLane, ctx, policy).verdict, 'allow');
});

test('array conditions and category matching', () => {
  const policy: Policy = {
    rules: [{ category: ['bugfix', 'refactor'], jurisdiction: ['CN'], verdict: 'block' }],
  };
  assert.equal(evaluate({ category: 'bugfix' }, workerLane, {}, policy).verdict, 'block');
  // Different category ⇒ no match ⇒ deny-by-default.
  assert.equal(evaluate({ category: 'docs' }, workerLane, {}, policy).verdict, 'force-trusted');
});

test('laneAllowedByVerdict interprets verdicts correctly', () => {
  assert.equal(laneAllowedByVerdict(workerLane, 'allow'), true);
  assert.equal(laneAllowedByVerdict(workerLane, 'block'), false);
  assert.equal(laneAllowedByVerdict(workerLane, 'force-trusted'), false); // worker ≠ full
  assert.equal(laneAllowedByVerdict(fullLane, 'force-trusted'), true); // full survives force-trusted
});

test('parsePolicyConfig accepts a valid policy and an empty/rule-less one', () => {
  assert.deepEqual(parsePolicyConfig('').rules, []);
  assert.deepEqual(parsePolicyConfig('rules: []').rules, []);
  const p = parsePolicyConfig('rules:\n  - sensitivity: sensitive\n    verdict: force-trusted\n');
  assert.equal(p.rules?.length, 1);
  assert.equal(p.rules?.[0]?.verdict, 'force-trusted');
});

test('parsePolicyConfig rejects malformed/invalid rules', () => {
  assert.throws(() => parsePolicyConfig('rules: notarray'), { name: 'PolicyConfigError', message: /"rules" must be an array/ });
  assert.throws(() => parsePolicyConfig('rules:\n  - verdict: maybe\n'), { message: /verdict must be one of/ });
  assert.throws(() => parsePolicyConfig('rules:\n  - verdict: allow\n    repo_class: galaxy\n'), { message: /repo_class has invalid value/ });
  assert.throws(() => parsePolicyConfig('rules:\n  - verdict: allow\n    bogus: 1\n'), { message: /unknown field "bogus"/ });
  assert.throws(() => parsePolicyConfig('- a\n- b'), { message: /must be a mapping/ });
  // Unknown top-level field (e.g. a `rules` typo) is rejected, not silently dropped.
  assert.throws(() => parsePolicyConfig('rule:\n  - verdict: allow\n'), { message: /unknown top-level field "rule"/ });
});

test('parsePolicyConfig parses and validates disabledLaneIds', () => {
  assert.deepEqual(parsePolicyConfig('disabledLaneIds: [a, b]').disabledLaneIds, ['a', 'b']);
  assert.throws(() => parsePolicyConfig('disabledLaneIds: notarray'), { message: /disabledLaneIds.*array of strings/ });
  assert.throws(() => parsePolicyConfig('disabledLaneIds: [1, 2]'), { message: /disabledLaneIds.*array of strings/ });
});

test('loadPolicyConfig reads and validates the shipped example', () => {
  const p = loadPolicyConfig(new URL('../../../config/policy.example.yaml', import.meta.url));
  assert.equal(p.rules?.length, 3);
});

test('loadPolicyConfig errors clearly for a missing file', () => {
  assert.throws(() => loadPolicyConfig('/no/such/policy.yaml'), {
    name: 'PolicyConfigError',
    message: /Could not read policy config/,
  });
});
