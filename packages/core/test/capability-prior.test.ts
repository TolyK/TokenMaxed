/**
 * Phase-1 rankings prior overlay: fallback ladder, movement caps, snapshot
 * validation, and routing wiring. Relative source imports (no-build test rule).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  MAX_PRIOR_DELTA,
  PRIOR_STRENGTH_BY_CONFIDENCE,
  clampOverlayPrior,
  computeSnapshotHash,
  overlayFromSnapshot,
  priorStrengthFromConfidence,
  resolvedPriorFor,
  validateSnapshot,
} from '../src/capability-prior.ts';
import type { CapabilitySnapshot } from '../src/capability-prior.ts';
import type { TaskCategory } from '../src/types.ts';
import { parseLaneConfig } from '../src/registry.ts';
import {
  DEFAULT_CAPABILITY,
  DEFAULT_PRIOR_STRENGTH,
  declaredCapabilityFor,
  effectiveCapability,
  effectiveCapabilityFor,
  routeDecide,
} from '../src/route.ts';
import { selectReviewManager } from '../src/review.ts';
import { reassignmentTarget } from '../src/reassign.ts';
import { validatePriceTable } from '../src/price.ts';
import type { CapabilityPriorEvidence, CapabilityPriorOverlay, Lane, Policy, RouteContext, Task } from '../src/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');

function near(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} ≈ ${expected}`);
}

const lane = (over: Partial<Lane> & { id: string }): Lane => ({
  kind: 'cli',
  model: 'gpt-5.5',
  trust_mode: 'full',
  costBasis: 'subscription',
  provenance: 'openai',
  jurisdiction: 'US',
  ...over,
});

const evidence = (value: number, over: Partial<CapabilityPriorEvidence> = {}): CapabilityPriorEvidence => ({
  value,
  source: 'mercor-apex-v1',
  chart: 'mercor-apex-v1',
  date: '2026-06-01',
  confidence: 'low',
  ...over,
});

const overlayFor = (laneId: string, category: Task['category'], entry: CapabilityPriorEvidence): CapabilityPriorOverlay => ({
  [laneId]: { [category]: entry },
});

test('opt-out (capability:0) survives every overlay path', () => {
  const l = lane({ id: 'opt', capability: { bugfix: 0 } });
  const priorOverlay = overlayFor('opt', 'bugfix', evidence(0.99));
  for (const stale of [false, true]) {
    const r = resolvedPriorFor(l, 'bugfix', priorOverlay, { stale, accepted: { opt: { bugfix: 0.1 } } });
    assert.equal(r.prior, 0);
    assert.equal(r.provenance, 'opt-out');
  }
  assert.equal(effectiveCapabilityFor(l, 'bugfix', undefined, { priorOverlay: priorOverlay }), 0);
  assert.equal(
    effectiveCapabilityFor(l, 'bugfix', { opt: { bugfix: { rate: 1.0, n: 100_000 } } }, { priorOverlay: priorOverlay }),
    0,
  );
});

test('pinned override ignores overlay', () => {
  const l = lane({ id: 'pin', capability_source: 'pinned', capability: { docs: 0.55 } });
  const priorOverlay = overlayFor('pin', 'docs', evidence(0.95));
  const r = resolvedPriorFor(l, 'docs', priorOverlay);
  assert.equal(r.prior, 0.55);
  assert.equal(r.provenance, 'pinned');
  assert.equal(r.evidence, undefined);
});

test('registry parses capability_source: pinned and resolvedPriorFor honors it', () => {
  const cfg = `
lanes:
  - id: pin
    kind: cli
    model: gpt-5.5
    trust_mode: full
    costBasis: subscription
    provenance: openai
    jurisdiction: US
    native: true
    capability_source: pinned
    capability:
      docs: 0.55
`;
  const parsed = parseLaneConfig(cfg).byId('pin');
  assert.ok(parsed);
  assert.equal(parsed.capability_source, 'pinned');

  const priorOverlay = overlayFor('pin', 'docs', evidence(0.95));
  const r = resolvedPriorFor(parsed, 'docs', priorOverlay);
  assert.equal(r.prior, 0.55);
  assert.equal(r.provenance, 'pinned');
  assert.equal(r.evidence, undefined);
});

test('fallback ladder order: overlay fresh → overlay stale → fallback → default', () => {
  const withCap = lane({ id: 'fb', capability: { docs: 0.61 } });
  const bare = lane({ id: 'def', model: 'unknown-model' });

  const fresh = resolvedPriorFor(withCap, 'docs', overlayFor('fb', 'docs', evidence(0.8)));
  assert.equal(fresh.provenance, 'overlay');
  assert.equal(fresh.prior, 0.8);

  const stale = resolvedPriorFor(withCap, 'docs', overlayFor('fb', 'docs', evidence(0.8)), { stale: true });
  assert.equal(stale.provenance, 'overlay-stale');

  const noEntry = resolvedPriorFor(withCap, 'docs', overlayFor('other', 'docs', evidence(0.9)));
  assert.equal(noEntry.provenance, 'fallback');
  assert.equal(noEntry.prior, 0.61);
  assert.equal(noEntry.unranked, true);

  const defaultPrior = resolvedPriorFor(bare, 'bugfix', overlayFor('other-lane', 'bugfix', evidence(0.9)));
  assert.equal(defaultPrior.provenance, 'default');
  assert.equal(defaultPrior.prior, DEFAULT_CAPABILITY);
});

test('±Δ clamp including first-acceptance baseline', () => {
  const l = lane({ id: 'c', capability: { docs: 0.5 } });
  const entry = overlayFor('c', 'docs', evidence(0.95));
  const first = resolvedPriorFor(l, 'docs', entry);
  assert.equal(first.prior, 0.7, 'first acceptance clamps to baseline + Δ');
  assert.equal(first.clamped, true);

  const second = resolvedPriorFor(l, 'docs', overlayFor('c', 'docs', evidence(0.95)), {
    accepted: { c: { docs: 0.7 } },
  });
  near(second.prior, 0.9, 1e-9);
  assert.equal(second.clamped, true);

  const down = resolvedPriorFor(l, 'docs', overlayFor('c', 'docs', evidence(0.1)), {
    accepted: { c: { docs: 0.7 } },
  });
  near(down.prior, 0.5);
  assert.equal(down.clamped, true);
});

test('stale feed: zero upward movement, downward allowed within Δ', () => {
  const l = lane({ id: 'st', capability: { explain: 0.6 } });
  const accepted = 0.6;
  const up = resolvedPriorFor(l, 'explain', overlayFor('st', 'explain', evidence(0.9)), {
    stale: true,
    accepted: { st: { explain: accepted } },
  });
  assert.equal(up.prior, accepted);
  assert.equal(up.provenance, 'overlay-stale');
  assert.equal(up.clamped, true);

  const down = resolvedPriorFor(l, 'explain', overlayFor('st', 'explain', evidence(0.3)), {
    stale: true,
    accepted: { st: { explain: accepted } },
  });
  near(down.prior, 0.4);
  assert.equal(down.clamped, true);
});

test('clampOverlayPrior exposes MAX_PRIOR_DELTA semantics', () => {
  const { value, clamped } = clampOverlayPrior(1.0, 0.5, false);
  near(value, 0.5 + MAX_PRIOR_DELTA);
  assert.equal(clamped, true);
});

test('clampOverlayPrior floors negative minAllowed at 0', () => {
  const reference = 0.1;
  assert.ok(reference < MAX_PRIOR_DELTA, 'minAllowed = reference - Δ is negative');

  const down = clampOverlayPrior(0.0, reference, false);
  assert.equal(down.value, 0, 'never negative when minAllowed < 0');
  assert.equal(down.clamped, false, 'proposed 0 already satisfies the widened floor');
  assert.ok(down.value >= 0 && down.value <= 1);

  const deep = clampOverlayPrior(-0.5, reference, false);
  assert.equal(deep.value, 0);
  assert.ok(deep.value >= 0 && deep.value <= 1);

  const up = clampOverlayPrior(1.0, reference, false);
  near(up.value, reference + MAX_PRIOR_DELTA);
  assert.equal(up.clamped, true);
  assert.ok(up.value >= 0 && up.value <= 1);
});

test('confidence maps to smaller k for low confidence', () => {
  assert.equal(priorStrengthFromConfidence('low'), PRIOR_STRENGTH_BY_CONFIDENCE.low);
  assert.ok(PRIOR_STRENGTH_BY_CONFIDENCE.low < DEFAULT_PRIOR_STRENGTH);
  assert.ok(PRIOR_STRENGTH_BY_CONFIDENCE.moderate < DEFAULT_PRIOR_STRENGTH);
  assert.equal(PRIOR_STRENGTH_BY_CONFIDENCE.high, DEFAULT_PRIOR_STRENGTH);

  const l = lane({ id: 'k' });
  const lowOverlay = overlayFor('k', 'docs', evidence(0.8, { confidence: 'low' }));
  const highOverlay = overlayFor('k', 'docs', evidence(0.8, { confidence: 'high' }));
  const observed = { rate: 0.0, n: 4 };
  const effLow = effectiveCapabilityFor(l, 'docs', { k: { docs: observed } }, { priorOverlay: lowOverlay });
  const effHigh = effectiveCapabilityFor(l, 'docs', { k: { docs: observed } }, { priorOverlay: highOverlay });
  assert.ok(effLow < effHigh, 'low-confidence prior is overridden faster by F-1');
});

test('unmatched model ⇒ unranked fallback via overlayFromSnapshot', () => {
  const snapshot: CapabilitySnapshot = {
    version: 1,
    generated: '2026-06-01',
    sources: ['mercor-apex-v1'],
    mapping: { docs: 'mercor-apex-v1' },
    aliases: { 'gpt-5.5': 'gpt-5.5' },
    entries: [
      {
        model: 'gpt-5.5',
        chart: 'mercor-apex-v1',
        category: 'docs',
        value: 0.7,
        source: 'mercor-apex-v1',
        date: '2026-06-01',
        confidence: 'low',
      },
    ],
    hash: '',
  };
  snapshot.hash = computeSnapshotHash(snapshot);
  const validated = validateSnapshot(snapshot);
  assert.equal(validated.valid, true);

  const matched = lane({ id: 'm1', model: 'gpt-5.5' });
  const unmatched = lane({ id: 'm2', model: 'no-alias-here' });
  const built = overlayFromSnapshot(validated.valid ? validated.snapshot : snapshot, [matched, unmatched]);
  assert.ok(built.overlay.m1?.docs);
  assert.equal(built.overlay.m2?.docs, undefined);
  assert.deepEqual(
    built.unranked.filter((u) => u.laneId === 'm2'),
    [{ laneId: 'm2', category: 'docs' }],
  );

  const r = resolvedPriorFor(unmatched, 'docs', built.overlay);
  assert.equal(r.provenance, 'default');
  assert.equal(r.unranked, true);
});

test('validateSnapshot passes the shipped seed file and rejects bad schema/hash', () => {
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'config/capability-snapshot.v1.json'), 'utf8'));
  const ok = validateSnapshot(raw);
  assert.equal(ok.valid, true);
  if (ok.valid) {
    assert.deepEqual(ok.snapshot.mapping, {
      docs: 'mercor-apex-v1',
      explain: 'mercor-apex-v1',
    });
    const mapping: Partial<Record<TaskCategory, string>> = ok.snapshot.mapping;
    for (const category of ['boilerplate', 'bugfix', 'refactor', 'feature', 'codegen'] as const) {
      assert.equal(mapping[category], undefined, `${category} must not map to APEX`);
    }
    assert.ok(ok.snapshot.entries.length > 0);
    for (const entry of ok.snapshot.entries) {
      assert.equal(entry.confidence, 'low');
    }
    assert.ok(ok.snapshot._note?.includes('SEED PLACEHOLDER'));
  }

  const badSchema = { version: 'x' };
  assert.equal(validateSnapshot(badSchema).valid, false);

  const badHash = { ...raw, hash: 'deadbeef' };
  const fail = validateSnapshot(badHash);
  assert.equal(fail.valid, false);
  if (!fail.valid) assert.match(fail.reason, /hash mismatch/);
});

test('no prior overlay ⇒ identical to declared behavior', () => {
  const l = lane({ id: 'd', capability: { bugfix: 0.72 } });
  near(effectiveCapabilityFor(l, 'bugfix'), declaredCapabilityFor(l, 'bugfix'));
  near(effectiveCapabilityFor(l, 'bugfix', undefined, {}), declaredCapabilityFor(l, 'bugfix'));

  const strong = lane({ id: 'strong', provenance: 'anthropic', capability: { bugfix: 0.85 } });
  const cheap = lane({ id: 'cheap', provenance: 'meta', costBasis: 'local', capability: { bugfix: 0.6 } });
  const task: Task = { category: 'bugfix' };
  const ctx: RouteContext = { lanes: [strong, cheap], policyContext: { repo_class: 'public', sensitivity: 'normal' } };
  const noPolicy: Policy = {};
  const without = routeDecide(task, ctx, noPolicy);
  const withEmpty = routeDecide(task, { ...ctx, capabilityPrior: Object.create(null) }, noPolicy);
  assert.equal(without.laneId, withEmpty.laneId);
  assert.deepEqual(without.scores, withEmpty.scores);
});

test('routeDecide uses rankings prior when overlay present', () => {
  const weak = lane({ id: 'weak', provenance: 'anthropic', capability: { docs: 0.55 } });
  const strong = lane({ id: 'strong', provenance: 'openai', model: 'gpt-5.5', capability: { docs: 0.4 } });
  const task: Task = { category: 'docs' };
  const ctx: RouteContext = {
    lanes: [weak, strong],
    policyContext: { repo_class: 'public', sensitivity: 'normal' },
    capabilityPrior: overlayFor('strong', 'docs', evidence(0.95)),
    capabilityPriorAccepted: { strong: { docs: 0.95 } },
  };
  const d = routeDecide(task, ctx, {});
  assert.equal(d.laneId, 'strong', 'overlay prior lifts the declared-underdog');
});

test('selectReviewManager stays on DECLARED capability when prior overlay is present', () => {
  const subject = lane({
    id: 'subj',
    provenance: 'moonshot',
    manager_allowed: false,
    capability: { bugfix: 0.6 },
  });
  const mgr = lane({ id: 'mgr', provenance: 'anthropic', manager_allowed: true, capability: { bugfix: 0.7 } });
  const ctx: RouteContext = {
    lanes: [subject, mgr],
    policyContext: { repo_class: 'public', sensitivity: 'normal' },
    capabilityPrior: overlayFor('subj', 'bugfix', evidence(0.99)),
  };
  assert.equal(selectReviewManager([subject, mgr], subject, 'bugfix', ctx, {})?.id, 'mgr');
});

test('reassignmentTarget uses effective capability with prior overlay', () => {
  const from = lane({ id: 'x', capability: { bugfix: 0.5 } });
  const to = lane({ id: 'y', provenance: 'openai', capability: { bugfix: 0.52 } });
  const task: Task = { category: 'bugfix' };
  const ctx: RouteContext = {
    lanes: [],
    policyContext: { repo_class: 'public', sensitivity: 'normal' },
    capabilityPrior: overlayFor('y', 'bugfix', evidence(0.85)),
  };
  assert.equal(reassignmentTarget(from, [to], task, ctx, {})?.id, 'y');
});

test('overlayFromSnapshot resolves <family>@latest via price table', () => {
  const table = validatePriceTable(
    JSON.parse(readFileSync(join(REPO_ROOT, 'config/prices.seed.json'), 'utf8')),
  );
  const seed = JSON.parse(readFileSync(join(REPO_ROOT, 'config/capability-snapshot.v1.json'), 'utf8'));
  const validated = validateSnapshot(seed);
  assert.equal(validated.valid, true);
  if (!validated.valid) return;

  const aliasLane = lane({ id: 'alias', model: 'claude-opus@latest' });
  const built = overlayFromSnapshot(validated.snapshot, [aliasLane], { priceTable: table });
  assert.ok(built.overlay.alias?.docs, 'resolved @latest maps through aliases');
});