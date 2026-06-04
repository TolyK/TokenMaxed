/**
 * A-8 — setup wiring. Creates the user-owned config (~/.tokenmaxed/lanes.yaml +
 * policy.yaml) from the shipped starters if absent (never overwrites), validates
 * by loading, and reports status (manager, secret scanner, gate). The starters
 * are shipped with the package and resolved module-relative (like the price
 * seed). Imports core/node at runtime — only loaded in the bundle, never by
 * node --test (the tool is tested via an injected setup dep).
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLaneConfig, loadPolicyConfig, makeGitleaksScanner } from '@tokenmaxed/core/node';

import { homeFile } from './config.ts';
import { selectManagerLane } from './host-review.ts';
import type { SetupReport } from './tools.ts';

const LANES_STARTER = fileURLToPath(new URL('../lanes.starter.yaml', import.meta.url));
const POLICY_STARTER = fileURLToPath(new URL('../policy.starter.yaml', import.meta.url));

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
  // filtered), so setup never claims a usable manager that review then rejects.
  const gateReady = env.TOKENMAXED_GATE_READY === 'true';
  const manager = selectManagerLane(registry.lanes, policy, gateReady);
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
    reviewOnStop: env.TOKENMAXED_REVIEW_ON_STOP === 'true',
    // Mirror makeServerDeps: the global kill-switch disables escalation.
    escalate:
      env.TOKENMAXED_ESCALATE === 'true' && !(env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true'),
    // F-1 learned capability; also disabled by the global kill-switch.
    learnCapability:
      env.TOKENMAXED_LEARN_CAPABILITY === 'true' && !(env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true'),
    // F-2 reader egress; also disabled by the global kill-switch.
    readerEgress:
      env.TOKENMAXED_READER_EGRESS === 'true' && !(env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true'),
  };
}
