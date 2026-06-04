import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LaneConfigError, LaneRegistry, parseLaneConfig } from '../src/registry.ts';
import { loadLaneConfig } from '../src/node.ts';

const VALID = `
lanes:
  - id: claude-native
    kind: cli
    model: claude-opus-4-7
    trust_mode: full
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    native: true
    capability:
      feature: 0.95
      explain: 0
  - id: ollama-llama3
    kind: local
    model: llama3.1:8b
    trust_mode: full
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
    (lane as { trust_mode: string }).trust_mode = 'worker';
  });
  assert.throws(() => {
    (lane.capability as Record<string, number>).feature = 0;
  });
  assert.equal(reg.byId('claude-native')?.trust_mode, 'full');
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
    trust_mode: full
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
    trust_mode: sorta
    costBasis: subscription
    provenance: p
    jurisdiction: US
`;
  assert.throws(() => parseLaneConfig(cfg), {
    message: /trust_mode must be one of: full, worker, reader, blocked/,
  });
});

test('rejects an unknown task category in capability', () => {
  const cfg = `
lanes:
  - id: x
    kind: cli
    model: m
    trust_mode: full
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
    trust_mode: full
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
    trust_mode: full
    costBasis: subscription
    provenance: p
    jurisdiction: US
    capabilty: {}
`;
  assert.throws(() => parseLaneConfig(cfg), { message: /unknown field "capabilty"/ });
});

test('parses the new trust/role/execution fields', () => {
  const cfg = `
lanes:
  - id: mgr
    kind: cli
    model: m
    trust_mode: full
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    command: claude
    roles: [manager]
    manager_allowed: true
    execution_mode: agentic
    attestation: false
`;
  const lane = parseLaneConfig(cfg).byId('mgr');
  assert.ok(lane);
  assert.deepEqual(lane.roles, ['manager']);
  assert.equal(lane.manager_allowed, true);
  assert.equal(lane.execution_mode, 'agentic');
  assert.equal(lane.attestation, false);
  // The roles array is frozen (deep immutability extends to it).
  assert.ok(Object.isFrozen(lane.roles));
  assert.throws(() => {
    (lane.roles as string[]).push('worker');
  });
});

test('rejects agentic execution_mode on a non-full lane (agentic ⊥ trust)', () => {
  const cfg = `
lanes:
  - id: w
    kind: api
    model: m
    trust_mode: worker
    costBasis: metered
    provenance: acme
    jurisdiction: US
    execution_mode: agentic
`;
  assert.throws(() => parseLaneConfig(cfg), {
    message: /'agentic' is only allowed when trust_mode is 'full'/,
  });
});

test('rejects bad role / boolean fields', () => {
  const bad = (extra: string): string =>
    `lanes:\n  - id: x\n    kind: cli\n    model: m\n    trust_mode: full\n    costBasis: subscription\n    provenance: p\n    jurisdiction: US\n${extra}`;
  assert.throws(() => parseLaneConfig(bad('    roles: [boss]\n')), { message: /roles\[0\] must be one of: manager, worker/ });
  assert.throws(() => parseLaneConfig(bad('    roles: notlist\n')), { message: /roles must be an array/ });
  assert.throws(() => parseLaneConfig(bad('    manager_allowed: yes\n')), { message: /manager_allowed must be a boolean/ });
  assert.throws(() => parseLaneConfig(bad('    attestation: 1\n')), { message: /attestation must be a boolean/ });
});

test('rejects duplicate lane ids', () => {
  const cfg = `
lanes:
  - id: dup
    kind: local
    model: m
    trust_mode: full
    costBasis: local
    provenance: p
    jurisdiction: US
  - id: dup
    kind: local
    model: n
    trust_mode: full
    costBasis: local
    provenance: q
    jurisdiction: US
`;
  assert.throws(() => parseLaneConfig(cfg), { message: /Duplicate lane id "dup"/ });
});

test('rejects a non-executable lane (cli without command, api without endpoint)', () => {
  const cli = `lanes:\n  - id: x\n    kind: cli\n    model: m\n    trust_mode: full\n    costBasis: subscription\n    provenance: p\n    jurisdiction: US\n`;
  assert.throws(() => parseLaneConfig(cli), { message: /non-native cli lane requires a command/ });
  const api = `lanes:\n  - id: x\n    kind: api\n    model: m\n    trust_mode: worker\n    costBasis: metered\n    provenance: p\n    jurisdiction: US\n`;
  assert.throws(() => parseLaneConfig(api), { message: /api lane requires an endpoint/ });
  // native lanes need no executor config; local defaults to localhost.
  const native = `lanes:\n  - id: h\n    kind: cli\n    model: m\n    trust_mode: full\n    costBasis: subscription\n    provenance: p\n    jurisdiction: US\n    native: true\n`;
  assert.equal(parseLaneConfig(native).byId('h')?.native, true);
  // A blocked lane stub can omit executor config (never selectable).
  const blocked = `lanes:\n  - id: off\n    kind: cli\n    model: m\n    trust_mode: blocked\n    costBasis: subscription\n    provenance: p\n    jurisdiction: US\n`;
  assert.equal(parseLaneConfig(blocked).byId('off')?.trust_mode, 'blocked');
});

test('rejects native on a non-full lane (contradictory)', () => {
  const cfg = `lanes:\n  - id: w\n    kind: api\n    model: m\n    trust_mode: worker\n    costBasis: metered\n    provenance: p\n    jurisdiction: US\n    endpoint: https://w\n    native: true\n`;
  assert.throws(() => parseLaneConfig(cfg), { message: /native is only valid on a full-trust lane/ });
});

test('loadLaneConfig reads and validates the shipped example file', () => {
  // Pass the file: URL directly; loadLaneConfig handles URL→path (and spaces).
  const examplePath = new URL('../../../config/lanes.example.yaml', import.meta.url);
  const reg = loadLaneConfig(examplePath);
  assert.equal(reg.lanes.length, 4);
  assert.ok(reg.byId('claude-native'));
  assert.ok(reg.byId('codex-cli'));
  assert.ok(reg.byId('ollama-llama3'));
  // Cheaper-Claude in-family lane (A-5b): a trusted `claude -p` CLI lane.
  const haiku = reg.byId('claude-haiku');
  assert.ok(haiku);
  assert.equal(haiku!.command, 'claude');
  assert.equal(haiku!.provenance, 'anthropic');
  assert.ok(reg instanceof LaneRegistry);
});

test('loadLaneConfig gives a clear error for a missing file', () => {
  assert.throws(() => loadLaneConfig('/no/such/lanes.yaml'), {
    name: 'LaneConfigError',
    message: /Could not read lane config/,
  });
});

// --- F2-S1: the reader trust tier + monitored alias --------------------------

const READER_LANE = `
lanes:
  - id: gemini-reader
    kind: api
    model: gemini-3.5-flash
    trust_mode: reader
    costBasis: subscription
    provenance: google
    jurisdiction: US
    endpoint: https://example.invalid
    repo_read_attestation: true
`;

test('parses a reader lane and its repo_read_attestation', () => {
  const reg = parseLaneConfig(READER_LANE);
  const lane = reg.byId('gemini-reader');
  assert.equal(lane?.trust_mode, 'reader');
  assert.equal(lane?.repo_read_attestation, true);
});

test("the deprecated 'monitored' trust_mode is normalized to 'reader'", () => {
  const cfg = `
lanes:
  - id: legacy
    kind: api
    model: m
    trust_mode: monitored
    costBasis: subscription
    provenance: p
    jurisdiction: US
    endpoint: https://example.invalid
`;
  assert.equal(parseLaneConfig(cfg).byId('legacy')?.trust_mode, 'reader');
});

test('a reader lane may omit executor config (not yet selectable until F-2 executor lands)', () => {
  const cfg = `
lanes:
  - id: stub-reader
    kind: cli
    model: m
    trust_mode: reader
    costBasis: subscription
    provenance: p
    jurisdiction: US
`;
  // No command/endpoint required for a reader (like blocked) — must not throw.
  assert.equal(parseLaneConfig(cfg).byId('stub-reader')?.trust_mode, 'reader');
});

test('repo_read_attestation is rejected on a non-reader lane', () => {
  const cfg = `
lanes:
  - id: full-lane
    kind: cli
    model: m
    trust_mode: full
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    command: claude
    repo_read_attestation: true
`;
  assert.throws(() => parseLaneConfig(cfg), { message: /repo_read_attestation.*only valid on a 'reader' lane/ });
});

test('repo_read_attestation: false is also rejected on a non-reader lane (no misleading opt-out)', () => {
  const cfg = `
lanes:
  - id: worker-lane
    kind: api
    model: m
    trust_mode: worker
    costBasis: metered
    provenance: deepseek
    jurisdiction: CN
    endpoint: https://example.invalid
    repo_read_attestation: false
`;
  assert.throws(() => parseLaneConfig(cfg), { message: /repo_read_attestation.*only valid on a 'reader' lane/ });
});
