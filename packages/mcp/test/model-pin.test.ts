/**
 * Per-request model PIN ("use minimax for this"): the pure matcher, preview
 * behavior, and delegate parity — an explicit pin is honored or honestly
 * refused, NEVER silently substituted.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { modelMatchesPin } from '../../core/src/index.ts';
import { CORE, makeServerDeps } from '../src/server.ts';
import { createTools, dispatch } from '../src/tools.ts';

const TOOLS = createTools(CORE);
const PRICES = fileURLToPath(new URL('../prices.seed.json', import.meta.url));

// The weaker lane's model is the PIN target — a pin must beat capability ranking.
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
    capability:
      bugfix: 0.9
  - id: weak
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

function setupDir(lanesYaml = LANES_YAML, extraEnv: Record<string, string> = {}): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-pin-'));
  writeFileSync(join(dir, 'lanes.yaml'), lanesYaml, 'utf8');
  return {
    dir,
    env: {
      TOKENMAXED_LANES: join(dir, 'lanes.yaml'),
      TOKENMAXED_LEDGER: join(dir, 'ledger.jsonl'),
      TOKENMAXED_STATE: join(dir, 'state.json'),
      TOKENMAXED_PRICES: PRICES,
      TOKENMAXED_PROJECT: 'pin-test',
      ...extraEnv,
    },
  };
}

test('modelMatchesPin: exact, family-prefix at boundaries, never bare-prefix bleed', () => {
  assert.equal(modelMatchesPin('minimax-m3', 'minimax'), true);
  assert.equal(modelMatchesPin('minimax-m3', 'MiniMax'), true); // case-insensitive
  assert.equal(modelMatchesPin('minimax-m3', 'minimax-m3'), true);
  assert.equal(modelMatchesPin('gpt-5.5', 'gpt-5'), true); // '.' boundary
  assert.equal(modelMatchesPin('claude-haiku-4-5', 'claude-haiku'), true);
  assert.equal(modelMatchesPin('gpt-5.5', 'gpt'), true); // '-' boundary — a deliberate family pin
  assert.equal(modelMatchesPin('gemini-3-pro', 'gem'), false); // NOT at a boundary
  assert.equal(modelMatchesPin('minimax-m3', 'minimax-m30'), false);
  assert.equal(modelMatchesPin('anything', ''), false);
});

test('preview: a pinned weaker model beats the stronger lane; the pin is stated', async () => {
  const { dir, env } = setupDir();
  try {
    const r = await dispatch(TOOLS, makeServerDeps(env), 'router_preview', { category: 'bugfix', model: 'weak-m' });
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'weak');
    assert.match(r.content[0]!.text, /model pinned by request: "weak-m"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preview: an unconnected pin is refused with the connected-models list (no substitution)', async () => {
  const { dir, env } = setupDir();
  try {
    const r = await dispatch(TOOLS, makeServerDeps(env), 'router_preview', { category: 'bugfix', model: 'mystery-9000' });
    assert.equal(r.structuredContent!.native, true);
    assert.match(r.content[0]!.text, /"mystery-9000" is not connected/);
    assert.match(r.content[0]!.text, /strong-m/);
    assert.deepEqual(r.structuredContent!.connectedModels, ['strong-m', 'weak-m']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delegate: the pin routes to the weaker lane and the reason carries the pin note', async () => {
  const { dir, env } = setupDir();
  try {
    const outcome = await makeServerDeps(env).delegate({ category: 'bugfix', instruction: 'noop', model: 'weak-m' });
    assert.equal(outcome.laneId, 'weak');
    assert.notEqual(outcome.native, true);
    assert.match(outcome.reason ?? '', /model "weak-m" pinned by your request/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delegate: an unconnected pin comes back native with the reason (never substituted)', async () => {
  const { dir, env } = setupDir();
  try {
    const outcome = await makeServerDeps(env).delegate({ category: 'bugfix', instruction: 'noop', model: 'mystery-9000' });
    assert.equal(outcome.native, true);
    assert.match(outcome.reason ?? '', /"mystery-9000" is not connected .* not substituting/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delegate: a pinned lane blocked by HOST gating comes back native — the pin never bypasses gates', async () => {
  const scoped = LANES_YAML.replace(
    `  - id: weak
    kind: cli
    model: weak-m
    command: node`,
    `  - id: weak
    kind: cli
    model: weak-m
    hosts: [claude-code]
    command: node`,
  );
  const { dir, env } = setupDir(scoped, { TOKENMAXED_HOST: 'codex-cli' });
  try {
    const outcome = await makeServerDeps(env).delegate({ category: 'bugfix', instruction: 'noop', model: 'weak-m' });
    assert.equal(outcome.native, true, JSON.stringify(outcome));
    assert.match(outcome.reason ?? '', /"weak-m" did not complete .* not substituting/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no pin ⇒ unchanged routing (the stronger lane wins as before)', async () => {
  const { dir, env } = setupDir();
  try {
    const outcome = await makeServerDeps(env).delegate({ category: 'bugfix', instruction: 'noop' });
    assert.equal(outcome.laneId, 'strong');
    assert.doesNotMatch(outcome.reason ?? '', /pinned/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- pin × escalation (review on) ------------------------------------------------

const MANAGED_LANES_YAML = `lanes:
  - id: pinned-mgr
    kind: cli
    model: pin-m
    command: node
    args: ['-e', 'process.stdout.write("done-pinned")']
    trust_mode: full
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    roles: [manager]
    manager_allowed: true
    capability:
      bugfix: 0.9
  - id: reviewer
    kind: cli
    model: reviewer-m
    command: node
    args: ['-e', 'process.stdout.write("VERDICT: pass")']
    trust_mode: full
    costBasis: subscription
    provenance: openai
    jurisdiction: US
    roles: [manager]
    manager_allowed: true
    attestation: true
    capability:
      bugfix: 0.95
`;

test('pin × escalation: a review-ELIGIBLE pinned lane still EXECUTES (never refused via reviewer reservation)', async () => {
  const { dir, env } = setupDir(MANAGED_LANES_YAML, { TOKENMAXED_ESCALATE: 'true' });
  try {
    const outcome = await makeServerDeps(env).delegate({ category: 'bugfix', instruction: 'noop', model: 'pin-m' });
    assert.equal(outcome.laneId, 'pinned-mgr', JSON.stringify(outcome)); // ran the pin
    assert.notEqual(outcome.native, true);
    assert.notEqual(outcome.reviewUnavailable, true, 'the independent reviewer must come from the manager pool');
    assert.match(outcome.reason ?? '', /pinned by your request/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pin × escalation: review gives the output back ⇒ honest RAN-but-given-back wording, no substitution', async () => {
  const failing = MANAGED_LANES_YAML.replace("process.stdout.write(\"VERDICT: pass\")", "process.stdout.write(\"VERDICT: fail\")");
  const { dir, env } = setupDir(failing, { TOKENMAXED_ESCALATE: 'true' });
  try {
    const outcome = await makeServerDeps(env).delegate({ category: 'bugfix', instruction: 'noop', model: 'pin-m' });
    assert.equal(outcome.native, true, JSON.stringify(outcome));
    assert.match(outcome.reason ?? '', /DID run; its output was given back by review/);
    assert.doesNotMatch(outcome.reason ?? '', /did not complete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preview: a pinned lane blocked by gates gets the pin-aware refusal (delegate parity)', async () => {
  const scoped = LANES_YAML.replace(
    `  - id: weak
    kind: cli
    model: weak-m
    command: node`,
    `  - id: weak
    kind: cli
    model: weak-m
    hosts: [claude-code]
    command: node`,
  );
  const { dir, env } = setupDir(scoped, { TOKENMAXED_HOST: 'codex-cli' });
  try {
    const r = await dispatch(TOOLS, makeServerDeps(env), 'router_preview', { category: 'bugfix', model: 'weak-m' });
    assert.equal(r.structuredContent!.native, true);
    assert.equal(r.structuredContent!.pinnedModel, 'weak-m');
    assert.match(r.content[0]!.text, /cannot run right now .* NOT substitute/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preview × escalation: a review-eligible pinned model previews as PINNED, not "not connected" (delegate parity)', async () => {
  const { dir, env } = setupDir(MANAGED_LANES_YAML, { TOKENMAXED_ESCALATE: 'true' });
  try {
    const r = await dispatch(TOOLS, makeServerDeps(env), 'router_preview', { category: 'bugfix', model: 'pin-m' });
    assert.notEqual(r.structuredContent!.native, true, r.content[0]!.text);
    assert.equal((r.structuredContent!.decision as { laneId: string }).laneId, 'pinned-mgr');
    assert.match(r.content[0]!.text, /model pinned by request: "pin-m"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pin × escalation: needs-rework REWORKS on the SAME pinned lane (maxEscalations: 0 preserves rework)', async () => {
  const dir0 = mkdtempSync(join(tmpdir(), 'tokenmaxed-pin-rework-'));
  // A stateful reviewer: needs-rework on the first review, pass on the second —
  // proving the rework leg ran (same lane) and converged, with escalation off.
  const marker = join(dir0, 'reviewed-once');
  const reworkYaml = MANAGED_LANES_YAML.replace(
    "args: ['-e', 'process.stdout.write(\"VERDICT: pass\")']",
    `args: ['-e', 'const fs=require("fs");const f=${JSON.stringify(marker)};if(fs.existsSync(f)){process.stdout.write("VERDICT: pass")}else{fs.writeFileSync(f,"1");process.stdout.write("VERDICT: needs-rework")}']`,
  );
  const { dir, env } = setupDir(reworkYaml, { TOKENMAXED_ESCALATE: 'true' });
  try {
    const outcome = await makeServerDeps(env).delegate({ category: 'bugfix', instruction: 'noop', model: 'pin-m' });
    assert.equal(outcome.laneId, 'pinned-mgr', JSON.stringify(outcome)); // the SAME pinned lane delivered
    assert.notEqual(outcome.native, true);
    assert.equal(outcome.receipt?.legs, 2, JSON.stringify(outcome.receipt)); // initial + rework leg
    assert.match(outcome.reason ?? '', /pinned by your request/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir0, { recursive: true, force: true });
  }
});
