/**
 * A-8 — setup wiring. Creates the user-owned config (~/.tokenmaxed/lanes.yaml +
 * policy.yaml) from the shipped starters if absent (never overwrites), validates
 * by loading, and reports status (manager, secret scanner, gate). The starters
 * are shipped with the package and resolved module-relative (like the price
 * seed). Imports core/node at runtime — only loaded in the bundle, never by
 * node --test (the tool is tested via an injected setup dep).
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isManagerEligible, resolveLaneModel } from '@tokenmaxed/core';
import { loadLaneConfig, loadPolicyConfig, loadPriceTable, makeGitleaksScanner } from '@tokenmaxed/core/node';

import { makeAvailabilityProbe } from './availability.ts';
import { homeFile } from './config.ts';
import type { LaneSetupRow } from './lane-setup.ts';
import { laneSetFingerprint, markLanesSeen, readLaneReviewState, writeLaneReviewState } from './lane-state.ts';
import { selectManagerLane } from './manager-select.ts';
import { parseMaxRounds, reviewLoopEnabled } from './reviewer.ts';
import type { SetupReport } from './tools.ts';

const LANES_STARTER = fileURLToPath(new URL('../lanes.starter.yaml', import.meta.url));
const POLICY_STARTER = fileURLToPath(new URL('../policy.starter.yaml', import.meta.url));
const DEFAULT_PRICES = fileURLToPath(new URL('../prices.seed.json', import.meta.url));

/** Create missing config from starters, validate, and report status. Idempotent. */
export async function runSetup(env: NodeJS.ProcessEnv): Promise<SetupReport> {
  const lanesPath = env.TOKENMAXED_LANES ?? homeFile('lanes.yaml');
  const policyPath = env.TOKENMAXED_POLICY ?? homeFile('policy.yaml');

  const lanesExisted = existsSync(lanesPath);
  if (!lanesExisted) {
    mkdirSync(dirname(lanesPath), { recursive: true });
    copyFileSync(LANES_STARTER, lanesPath);
  }
  const policyExisted = existsSync(policyPath);
  if (!policyExisted) {
    mkdirSync(dirname(policyPath), { recursive: true });
    copyFileSync(POLICY_STARTER, policyPath);
  }

  // Validate BOTH configs by loading (throws on a malformed file — surfaced to the
  // user — so setup never reports success over a policy that later calls reject).
  const registry = loadLaneConfig(lanesPath);
  const policy = loadPolicyConfig(policyPath);
  // Report the manager EXACTLY as the review path would select it (gate + policy
  // + availability filtered), so setup never claims a manager that isn't installed
  // and would fail the moment review runs.
  const gateReady = env.TOKENMAXED_GATE_READY === 'true';
  const available = new Set(await makeAvailabilityProbe(env)([...registry.lanes]));
  const manager = selectManagerLane(registry.lanes, policy, gateReady, available);

  // SETUP-1: a per-lane confirmation — model (resolved if @latest), trust/permissions,
  // role, availability, declared capability. Role uses the REAL selectors (active
  // reviewer = selectManagerLane; else manager-eligible) — never raw `roles`.
  let priceTable: ReturnType<typeof loadPriceTable> | undefined;
  try {
    priceTable = loadPriceTable(env.TOKENMAXED_PRICES ?? DEFAULT_PRICES);
  } catch {
    priceTable = undefined; // no price table ⇒ show raw model ids (no @latest resolution)
  }
  const laneRows: LaneSetupRow[] = registry.lanes.map((l) => {
    const resolved = priceTable ? resolveLaneModel(l, priceTable).model : l.model;
    const role: LaneSetupRow['role'] =
      manager && manager.id === l.id ? 'active-reviewer' : isManagerEligible(l) ? 'manager-eligible' : 'none';
    return {
      id: l.id,
      kind: l.kind,
      model: resolved,
      ...(resolved !== l.model ? { rawModel: l.model } : {}),
      trustMode: l.trust_mode,
      costBasis: l.costBasis,
      executionMode: (l.execution_mode ?? 'answer-only') as 'answer-only' | 'agentic',
      role,
      available: !!l.native || available.has(l.id),
      ...(l.capability ? { capability: l.capability } : {}),
    };
  });

  // SETUP-1 B: detect whether the lane set changed since this project last reviewed it,
  // then MARK SEEN (setup is the explicit, visible surface — the only one that writes).
  // Fingerprint the RAW lanes (config), per Codex — not the resolved @latest models.
  const projectKey = env.TOKENMAXED_PROJECT ?? env.CLAUDE_PROJECT_DIR ?? 'default';
  const statePath =
    env.TOKENMAXED_STATE ?? (env.CLAUDE_PLUGIN_DATA ? join(env.CLAUDE_PLUGIN_DATA, 'state.json') : homeFile('state.json'));
  const laneStatePath = env.TOKENMAXED_LANE_STATE ?? join(dirname(statePath), 'lane-review.json');
  const fingerprint = laneSetFingerprint(registry.lanes);
  const reviewState = readLaneReviewState(laneStatePath);
  const prior = Object.hasOwn(reviewState.byProject, projectKey) ? reviewState.byProject[projectKey]!.fingerprint : undefined;
  const laneReview: SetupReport['laneReview'] = prior === undefined ? 'first-review' : prior !== fingerprint ? 'changed' : 'current';
  writeLaneReviewState(laneStatePath, markLanesSeen(reviewState, projectKey, fingerprint));

  // Probe scanner health with a benign input (never sends anything). makeGitleaksScanner
  // fails CLOSED (available:true, hasSecret:true) when the probe itself errors, so a
  // benign input flagged as a "secret" means the scanner is broken — report unusable.
  const scan = await makeGitleaksScanner()(['']);
  const gitleaksAvailable = scan.available && !scan.hasSecret;

  return {
    lanesPath,
    policyPath,
    lanesCreated: !lanesExisted,
    policyCreated: !policyExisted,
    laneCount: registry.lanes.length,
    ...(manager ? { managerLaneId: manager.id } : {}),
    gitleaksAvailable,
    gateReady,
    // REVIEW-LOOP: default-ON (on whenever a usable reviewer lane exists); opt out
    // with TOKENMAXED_REVIEW_ON_STOP=false. Reported with its rework-round bound.
    reviewOnStop: reviewLoopEnabled(env),
    reviewMaxRounds: parseMaxRounds(env),
    // Mirror makeServerDeps: the global kill-switch disables escalation.
    escalate:
      env.TOKENMAXED_ESCALATE === 'true' && !(env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true'),
    // F-1 learned capability; also disabled by the global kill-switch.
    learnCapability:
      env.TOKENMAXED_LEARN_CAPABILITY === 'true' && !(env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true'),
    // F-2 reader egress; also disabled by the global kill-switch.
    readerEgress:
      env.TOKENMAXED_READER_EGRESS === 'true' && !(env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true'),
    // MODEL-TIERS tiered routing; also disabled by the global kill-switch.
    tiered:
      env.TOKENMAXED_TIERED === 'true' && !(env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true'),
    lanes: laneRows,
    laneReview,
  };
}
