import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LaneConfigError, LaneRegistry, parseLaneConfig } from '../src/registry.ts';
import { loadLaneConfig } from '../src/node.ts';

const VALID = `
lanes:
  - id: claude-native
    kind: cli
    model: claude-opus-4-7
    trust: trusted
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    capability:
      feature: 0.95
      explain: 0
  - id: ollama-llama3
    kind: local
    model: llama3.1:8b
    trust: trusted
    costBasis: local
    provenance: meta
    jurisdiction: US
    capability:
      explain: 0.6
`;

test('parses a valid config into typed lanes', () => {
  const reg = parseLaneConfig(VALID);
  assert.equal(reg.lanes.length, 2);
  const claude = reg.byId('claude-native');
  assert.ok(claude);
  assert.equal(claude.kind, 'cli');
  assert.equal(claude.costBasis, 'subscription');
  assert.equal(claude.capability?.feature, 0.95);
});

test('byId returns undefined for an unknown lane', () => {
  assert.equal(parseLaneConfig(VALID).byId('nope'), undefined);
});

test('candidateLanes includes lanes that meet/omit the category, excludes opted-out (0)', () => {
  const reg = parseLaneConfig(VALID);
  // Both lanes score "explain": claude is explicitly 0 (opted out), ollama is 0.6.
  const explain = reg.candidateLanes('explain').map((l) => l.id);
  assert.deepEqual(explain, ['ollama-llama3']);
  // "bugfix" is unspecified for both → both use the default capability → both eligible.
  const bugfix = reg.candidateLanes('bugfix').map((l) => l.id);
  assert.deepEqual(bugfix, ['claude-native', 'ollama-llama3']);
});

test('candidateLanes preserves configuration order', () => {
  const reg = parseLaneConfig(VALID);
  assert.deepEqual(
    reg.candidateLanes('feature').map((l) => l.id),
    ['claude-native', 'ollama-llama3'],
  );
});

test('the registry is deeply immutable (list, lanes, and capability maps frozen)', () => {
  const reg = parseLaneConfig(VALID);
  assert.throws(() => {
    (reg.lanes as unknown[]).push({});
  });
  const lane = reg.byId('claude-native');
  assert.ok(lane);
  assert.ok(Object.isFrozen(lane));
  assert.ok(Object.isFrozen(lane.capability));
  // Mutating a returned lane must not change later routing inputs.
  assert.throws(() => {
    (lane as { trust: string }).trust = 'untrusted';
  });
  assert.throws(() => {
    (lane.capability as Record<string, number>).feature = 0;
  });
  assert.equal(reg.byId('claude-native')?.trust, 'trusted');
  assert.equal(reg.byId('claude-native')?.capability?.feature, 0.95);
});

test('rejects malformed YAML with a clear LaneConfigError', () => {
  assert.throws(
    () => parseLaneConfig('lanes: [unterminated'),
    (err: unknown) => err instanceof LaneConfigError && /parse/i.test((err as Error).message),
  );
});

test('rejects a non-mapping top level', () => {
  assert.throws(() => parseLaneConfig('- just\n- a\n- list'), {
    name: 'LaneConfigError',
    message: /must be a mapping with a "lanes" array/,
  });
});

test('rejects an empty lanes array', () => {
  assert.throws(() => parseLaneConfig('lanes: []'), { message: /empty/ });
});

test('rejects a missing required field', () => {
  const cfg = `
lanes:
  - id: x
    kind: cli
    trust: trusted
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
`;
  assert.throws(() => parseLaneConfig(cfg), { message: /model must be a non-empty string/ });
});

test('rejects an invalid enum value with the allowed set', () => {
  const cfg = `
lanes:
  - id: x
    kind: cli
    model: m
    trust: sorta-trusted
    costBasis: subscription
    provenance: p
    jurisdiction: US
`;
  assert.throws(() => parseLaneConfig(cfg), { message: /trust must be one of: trusted, untrusted/ });
});

test('rejects an unknown task category in capability', () => {
  const cfg = `
lanes:
  - id: x
    kind: cli
    model: m
    trust: trusted
    costBasis: subscription
    provenance: p
    jurisdiction: US
    capability:
      not_a_category: 0.5
`;
  assert.throws(() => parseLaneConfig(cfg), { message: /not a known task category/ });
});

test('rejects a capability value out of [0, 1]', () => {
  const cfg = `
lanes:
  - id: x
    kind: cli
    model: m
    trust: trusted
    costBasis: subscription
    provenance: p
    jurisdiction: US
    capability:
      feature: 1.5
`;
  assert.throws(() => parseLaneConfig(cfg), { message: /must be a number in \[0, 1\]/ });
});

test('rejects an unknown lane field (likely typo)', () => {
  const cfg = `
lanes:
  - id: x
    kind: cli
    model: m
    trust: trusted
    costBasis: subscription
    provenance: p
    jurisdiction: US
    capabilty: {}
`;
  assert.throws(() => parseLaneConfig(cfg), { message: /unknown field "capabilty"/ });
});

test('rejects duplicate lane ids', () => {
  const cfg = `
lanes:
  - id: dup
    kind: cli
    model: m
    trust: trusted
    costBasis: subscription
    provenance: p
    jurisdiction: US
  - id: dup
    kind: local
    model: n
    trust: trusted
    costBasis: local
    provenance: q
    jurisdiction: US
`;
  assert.throws(() => parseLaneConfig(cfg), { message: /Duplicate lane id "dup"/ });
});

test('loadLaneConfig reads and validates the shipped example file', () => {
  // Pass the file: URL directly; loadLaneConfig handles URL→path (and spaces).
  const examplePath = new URL('../../../config/lanes.example.yaml', import.meta.url);
  const reg = loadLaneConfig(examplePath);
  assert.equal(reg.lanes.length, 3);
  assert.ok(reg.byId('claude-native'));
  assert.ok(reg.byId('codex-cli'));
  assert.ok(reg.byId('ollama-llama3'));
  assert.ok(reg instanceof LaneRegistry);
});

test('loadLaneConfig gives a clear error for a missing file', () => {
  assert.throws(() => loadLaneConfig('/no/such/lanes.yaml'), {
    name: 'LaneConfigError',
    message: /Could not read lane config/,
  });
});
