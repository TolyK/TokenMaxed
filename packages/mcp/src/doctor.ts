import { basename, dirname, join } from 'node:path';
import { existsSync, readdirSync, realpathSync } from 'node:fs';

import { isManagerEligible, assessDeprecation, resolveLaneModel } from '@tokenmaxed/core';
import { loadLaneConfig, loadPolicyConfig, loadPriceTable } from '@tokenmaxed/core/node';
import type { Lane, LaneRegistry } from '@tokenmaxed/core';

import { isLaneAvailable, commandOnPath, makeAvailabilityDeps } from './availability.ts';
import { homeFile } from './config.ts';
import { settingsReport } from './settings.ts';
import { readFreshnessCache, getEntry, isFresh } from './model-cache.ts';

export interface DoctorFinding {
  severity: 'error' | 'warn' | 'info';
  title: string;
  detail: string;
  fix: string;
}

export interface DoctorReport {
  findings: DoctorFinding[];
}

export function checkDuplicatePlugins(env: NodeJS.ProcessEnv): { title: string; detail: string; fix: string } | null {
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) return null;
  try {
    const parentDir = dirname(pluginRoot);
    if (existsSync(parentDir)) {
      const entries = readdirSync(parentDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      if (dirs.length > 1) {
        const activeResolved = realpathSync(pluginRoot);
        const inactivePaths: string[] = [];
        const infoLines: string[] = [];

        for (const dir of dirs) {
          const fullPath = join(parentDir, dir);
          let resolved = '';
          try {
            resolved = realpathSync(fullPath);
          } catch {
            resolved = fullPath;
          }
          const isActive = resolved === activeResolved;
          infoLines.push(`  - ${dir} (${isActive ? 'ACTIVE' : 'INACTIVE'})`);
          if (!isActive) {
            inactivePaths.push(fullPath);
          }
        }

        if (inactivePaths.length > 0) {
          return {
            title: 'Multiple TokenMaxed plugin installations detected',
            detail: `Found ${dirs.length} versioned/installation directories in the plugin cache under "${parentDir}":\n` +
              infoLines.join('\n'),
            fix: `Remove the inactive directories to avoid running stale bundle code. Run:\n` +
              inactivePaths.map((p) => `  rm -rf "${p}"`).join('\n'),
          };
        }
      }
    }
  } catch {
    // Fail-open: caught by caller to emit indeterminate warning
    throw new Error('plugin check failed');
  }
  return null;
}

export async function runDoctor(
  env: NodeJS.ProcessEnv,
  deps: {
    freshness?: () => Promise<any[]>;
    idMismatch?: () => Promise<any[]>;
  },
): Promise<DoctorReport> {
  const findings: DoctorFinding[] = [];

  // 1. Duplicate plugin check (Fail-open to indeterminate warning)
  try {
    const dup = checkDuplicatePlugins(env);
    if (dup) {
      findings.push({ severity: 'warn', ...dup });
    }
  } catch {
    findings.push({
      severity: 'warn',
      title: "Couldn't determine duplicate plugin status",
      detail: 'duplicate plugin directory check failed',
      fix: 'Verify the plugin directory permissions.',
    });
  }

  // 2. Settings configuration check (uses settingsReport for corruption)
  try {
    const rep = settingsReport(env);
    if (rep.present) {
      if (rep.warning) {
        findings.push({
          severity: 'warn',
          title: 'Settings configuration is malformed',
          detail: 'settings.json failed to parse (invalid JSON) — check syntax',
          fix: 'Fix the JSON syntax of settings.json or delete it to reset.',
        });
      }
      if (rep.invalid && rep.invalid.length > 0) {
        findings.push({
          severity: 'warn',
          title: 'Invalid keys in settings configuration',
          detail: 'One or more keys in settings.json have invalid types or values.',
          fix: 'Check the values in settings.json and ensure they have the correct types.',
        });
      }
    }
  } catch {
    findings.push({
      severity: 'warn',
      title: "Couldn't determine settings status",
      detail: 'settings check failed',
      fix: 'Verify the settings.json file permissions.',
    });
  }

  // 3. Secret scanner (gitleaks) check - STRICTLY read-only binary check on PATH
  let gitleaksAvailable = false;
  let availabilityDeps: any;
  try {
    availabilityDeps = makeAvailabilityDeps(env);
    gitleaksAvailable = commandOnPath('gitleaks', availabilityDeps.path);
    if (!gitleaksAvailable) {
      findings.push({
        severity: 'warn',
        title: 'Secret scanner (gitleaks) not installed',
        detail: 'gitleaks is not found on your system or is not executable. This is required for untrusted worker/reader gates to scan files for secrets before routing.',
        fix: 'Install gitleaks (e.g., via "brew install gitleaks") and ensure it is in your PATH.',
      });
    }
  } catch {
    findings.push({
      severity: 'warn',
      title: "Couldn't determine secret scanner status",
      detail: 'gitleaks presence check failed',
      fix: 'Check your PATH settings.',
    });
  }

  const lanesPath = env.TOKENMAXED_LANES ?? homeFile('lanes.yaml');
  const policyPath = env.TOKENMAXED_POLICY ?? homeFile('policy.yaml');

  let registry: LaneRegistry | undefined;

  // 4. Config files check - CONTENT-FREE error formatting
  try {
    if (!existsSync(lanesPath)) {
      findings.push({
        severity: 'error',
        title: 'Lanes configuration file missing',
        detail: `Lanes config file not found at local config path.`,
        fix: 'Run /tokenmaxed:setup to generate lanes.yaml from the starter template.',
      });
    } else {
      registry = loadLaneConfig(lanesPath);
      if (!registry.lanes || registry.lanes.length === 0) {
        findings.push({
          severity: 'error',
          title: 'No lanes configured',
          detail: 'The lanes registry contains zero lanes.',
          fix: 'Add at least one lane definition to your lanes.yaml.',
        });
      } else {
        const enabledLanes = registry.lanes.filter((l) => l.trust_mode !== 'blocked');
        if (enabledLanes.length === 0) {
          findings.push({
            severity: 'error',
            title: 'No enabled lanes',
            detail: 'All configured lanes in lanes.yaml are set to trust_mode: "blocked".',
            fix: 'Set trust_mode to "full", "worker", or "reader" on at least one lane in lanes.yaml.',
          });
        }

        const hasManager = registry.lanes.some((l) => isManagerEligible(l));
        if (!hasManager) {
          findings.push({
            severity: 'warn',
            title: 'No manager/reviewer lane configured',
            detail: 'No lane in lanes.yaml is configured as eligible to act as a manager (requires trust_mode: "full" and manager_allowed: true).',
            fix: 'Set manager_allowed: true on a trusted local or CLI lane (e.g., claude-native) in lanes.yaml.',
          });
        }
      }
    }
  } catch {
    findings.push({
      severity: 'error',
      title: 'Lanes configuration is malformed',
      detail: 'lanes.yaml failed to parse (invalid YAML) — check syntax',
      fix: 'Fix the YAML syntax or fields in your lanes.yaml file.',
    });
  }

  try {
    if (!existsSync(policyPath)) {
      findings.push({
        severity: 'error',
        title: 'Policy configuration file missing',
        detail: 'Policy config file not found at local config path.',
        fix: 'Run /tokenmaxed:setup to generate policy.yaml from the starter template.',
      });
    } else {
      loadPolicyConfig(policyPath);
    }
  } catch {
    findings.push({
      severity: 'error',
      title: 'Policy configuration is malformed',
      detail: 'policy.yaml failed to parse (invalid YAML) — check syntax',
      fix: 'Fix the YAML syntax or fields in your policy.yaml file.',
    });
  }

  // 5. Gates and flags state
  if (registry) {
    const gateReady = env.TOKENMAXED_GATE_READY === 'true';
    const readerEgress = env.TOKENMAXED_READER_EGRESS === 'true' && !(env.TOKENMAXED_DISABLE === '1' || env.TOKENMAXED_DISABLE === 'true');

    const workerLanes = registry.lanes.filter((l) => l.trust_mode === 'worker');
    if (workerLanes.length > 0 && !gateReady) {
      findings.push({
        severity: 'warn',
        title: 'Worker lanes unusable because worker gate is closed',
        detail: 'Worker lanes are configured but the worker gate is closed.',
        fix: 'Enable the worker gate by running "/tokenmaxed:config gate_ready true" or setting TOKENMAXED_GATE_READY=true in your environment.',
      });
    }

    const readerLanes = registry.lanes.filter((l) => l.trust_mode === 'reader');
    if (readerLanes.length > 0) {
      if (!readerEgress) {
        findings.push({
          severity: 'warn',
          title: 'Reader lanes unusable because reader egress is disabled',
          detail: 'Reader lanes are configured but reader egress is disabled.',
          fix: 'Enable reader egress by running "/tokenmaxed:config reader_egress true" or setting TOKENMAXED_READER_EGRESS=true in your environment.',
        });
      }

      for (const lane of readerLanes) {
        if (lane.repo_read_attestation !== true) {
          findings.push({
            severity: 'warn',
            title: `Reader lane "${lane.id}" lacks attestation`,
            detail: 'Reader lane requires "repo_read_attestation: true" in lanes.yaml to receive repo-read content.',
            fix: `Add "repo_read_attestation: true" to lane "${lane.id}" in lanes.yaml.`,
          });
        }
      }
    }

    // 6. Lane availability checks - deterministic REGISTRY order
    try {
      if (!availabilityDeps) {
        availabilityDeps = makeAvailabilityDeps(env);
      }
      const lanesToProbe = registry.lanes.filter((l) => !l.native && l.trust_mode !== 'blocked');

      const probeResults = await Promise.all(
        lanesToProbe.map(async (lane) => {
          try {
            const isAvailable = await isLaneAvailable(lane, availabilityDeps);
            if (!isAvailable) {
              let detail = '';
              let fix = '';
              if (lane.kind === 'cli') {
                const cmd = lane.command ?? '';
                const hasCommand = commandOnPath(cmd, availabilityDeps.path);
                if (!hasCommand) {
                  detail = 'CLI command is not executable or not found on PATH.';
                  fix = 'Install the CLI tool or check your PATH environment variable.';
                } else {
                  const base = cmd.split('/').pop();
                  if (base === 'node') {
                    detail = 'Node script referenced by CLI lane was not found.';
                    fix = 'Check if the script file exists at the configured path in lanes.yaml.';
                  } else {
                    detail = 'CLI command failed the execution check.';
                    fix = 'Check the command path and arguments in lanes.yaml.';
                  }
                }
              } else if (lane.kind === 'local') {
                detail = 'Local server endpoint is unreachable.';
                fix = 'Start your local server and verify it is running.';
              } else if (lane.kind === 'api') {
                detail = 'BYOK API key is missing or empty for the configured auth handle.';
                fix = `Set the environment variable TOKENMAXED_KEY_${lane.authHandle ?? ''} to a valid API key.`;
              } else {
                detail = 'Lane kind is unknown or unsupported.';
                fix = 'Change the lane kind in lanes.yaml to "cli", "local", or "api".';
              }

              return {
                laneId: lane.id,
                finding: {
                  severity: 'warn' as const,
                  title: `Lane "${lane.id}" is unavailable`,
                  detail,
                  fix,
                },
              };
            }
            return { laneId: lane.id, available: true };
          } catch {
            return {
              laneId: lane.id,
              finding: {
                severity: 'warn' as const,
                title: `Couldn't determine availability for lane "${lane.id}"`,
                detail: 'lane availability probe failed',
                fix: 'Check the lane settings in lanes.yaml.',
              },
            };
          }
        })
      );

      // Collect unavailable lane IDs to check if all non-native lanes are down
      const unavailableLaneIds = new Set<string>();
      const nonNativeEnabledLanes = registry.lanes.filter((l) => !l.native && l.trust_mode !== 'blocked');

      // Append findings in deterministic registry order
      for (const res of probeResults) {
        if (res && res.finding) {
          findings.push(res.finding);
          unavailableLaneIds.add(res.laneId);
        }
      }

      // Blocker check: No runnable non-native lanes at all (ERROR)
      if (nonNativeEnabledLanes.length > 0 && unavailableLaneIds.size === nonNativeEnabledLanes.length) {
        findings.push({
          severity: 'error',
          title: 'No runnable non-native lanes available',
          detail: 'All configured non-native lanes are unavailable for routing.',
          fix: 'Fix the individual lane errors reported below.',
        });
      }
    } catch {
      findings.push({
        severity: 'warn',
        title: "Couldn't determine lane availability",
        detail: 'lane availability probe failed',
        fix: 'Verify that node and environment PATH are configured correctly.',
      });
    }

    // 7. Freshness check (Fail-open to indeterminate warning) - deterministic registry order
    const statePath = env.TOKENMAXED_STATE ?? (env.CLAUDE_PLUGIN_DATA ? join(env.CLAUDE_PLUGIN_DATA, 'state.json') : homeFile('state.json'));
    const cachePath = env.TOKENMAXED_MODEL_CACHE ?? join(dirname(statePath), 'model-freshness.json');
    const keyedApiLanes = registry.lanes.filter(
      (l) => l.kind === 'api' && l.trust_mode !== 'blocked' && !!l.authHandle
    );

    if (deps.freshness) {
      try {
        const freshnessWarnings = await deps.freshness();
        let missingEndpointLanes: string[] = [];
        let staleOrMissingCacheLanes: string[] = [];

        if (keyedApiLanes.length > 0) {
          const cache = readFreshnessCache(cachePath);
          const now = Date.now();
          const ID_MISMATCH_TTL_MS = 10 * 60_000;
          for (const lane of keyedApiLanes) {
            if (!lane.endpoint) {
              missingEndpointLanes.push(lane.id);
              continue;
            }
            const entry = getEntry(cache, lane.endpoint);
            if (!entry || !isFresh(entry, now, ID_MISMATCH_TTL_MS)) {
              staleOrMissingCacheLanes.push(lane.id);
            }
          }
        }

        for (const laneId of missingEndpointLanes) {
          findings.push({
            severity: 'warn',
            title: `Lane "${laneId}" has no endpoint`,
            detail: `api lane ${laneId} has no endpoint — cannot verify model freshness / it can't run`,
            fix: `Define a valid endpoint URL for lane "${laneId}" in lanes.yaml.`,
          });
        }

        for (const laneId of staleOrMissingCacheLanes) {
          findings.push({
            severity: 'warn',
            title: `Model freshness not verified for lane "${laneId}"`,
            detail: `model freshness not verified for lane "${laneId}" — no/stale cache; run /tokenmaxed:status to populate it`,
            fix: 'Run /tokenmaxed:status to populate and refresh the model cache.',
          });
        }

        // Sort/flatten in registry order
        const warningMap = new Map(freshnessWarnings.map((w) => [w.laneId, w]));
        for (const lane of registry.lanes) {
          const w = warningMap.get(lane.id);
          if (w) {
            findings.push({
              severity: 'warn',
              title: `Stale model ID pinned for lane "${w.laneId}"`,
              detail: 'pinned model is stale; newer model available in the same family.',
              fix: w.newestPriced
                ? 'Update the lane\'s model in lanes.yaml to use @latest or pin the new version.'
                : 'A newer model exists but is not priced in TokenMaxed yet. Add it to the price table to route to it.',
            });
          }
        }
      } catch {
        findings.push({
          severity: 'warn',
          title: "Couldn't determine model freshness",
          detail: 'model freshness validation failed',
          fix: 'Check your internet connection.',
        });
      }
    }

    // 8. Casing check (Fail-open to indeterminate warning) - deterministic registry order
    if (deps.idMismatch) {
      try {
        const mismatchWarnings = await deps.idMismatch();
        let missingEndpointLanes: string[] = [];
        let staleOrMissingCacheLanes: string[] = [];

        if (keyedApiLanes.length > 0) {
          const cache = readFreshnessCache(cachePath);
          const now = Date.now();
          const ID_MISMATCH_TTL_MS = 10 * 60_000;
          for (const lane of keyedApiLanes) {
            if (!lane.endpoint) {
              missingEndpointLanes.push(lane.id);
              continue;
            }
            const entry = getEntry(cache, lane.endpoint);
            if (!entry || !isFresh(entry, now, ID_MISMATCH_TTL_MS)) {
              staleOrMissingCacheLanes.push(lane.id);
            }
          }
        }

        for (const laneId of missingEndpointLanes) {
          findings.push({
            severity: 'warn',
            title: `Lane "${laneId}" has no endpoint`,
            detail: `api lane ${laneId} has no endpoint — cannot verify model ID casing / it can't run`,
            fix: `Define a valid endpoint URL for lane "${laneId}" in lanes.yaml.`,
          });
        }

        for (const laneId of staleOrMissingCacheLanes) {
          findings.push({
            severity: 'warn',
            title: `Model ID casing validation not verified for lane "${laneId}"`,
            detail: `model ID casing validation could not be evaluated for lane "${laneId}" — no/stale cache; run /tokenmaxed:status to populate it`,
            fix: 'Run /tokenmaxed:status to populate and refresh the model cache.',
          });
        }

        const warningMap = new Map(mismatchWarnings.map((w) => [w.laneId, w]));
        for (const lane of registry.lanes) {
          const w = warningMap.get(lane.id);
          if (w) {
            findings.push({
              severity: 'warn',
              title: `Model ID casing/existence mismatch for lane "${w.laneId}"`,
              detail: 'Model ID sent to provider is not recognized or expects different casing.',
              fix: 'Fix the model ID casing in lanes.yaml or the price table.',
            });
          }
        }
      } catch {
        findings.push({
          severity: 'warn',
          title: "Couldn't determine model ID casing status",
          detail: 'model ID casing validation failed',
          fix: 'Verify the model cache.',
        });
      }
    }

    // 9. Deprecation check
    if (registry) {
      const pricesPath = env.TOKENMAXED_PRICES ?? homeFile('prices.json');
      if (existsSync(pricesPath)) {
        try {
          const priceTable = loadPriceTable(pricesPath);
          const now = Date.now();
          for (const lane of registry.lanes) {
            const concrete = resolveLaneModel(lane, priceTable).model;
            const report = assessDeprecation(concrete, priceTable, now);
            if (report.status === 'deprecated') {
              const dateStr = report.from ? `since ${report.from}` : 'immediately';
              let detail = '';
              let fix = '';
              if (!report.successor) {
                detail = `lane ${lane.id} uses ${concrete}, deprecated ${dateStr} → no successor configured`;
                fix = `Update the lane's model in lanes.yaml to a non-deprecated model.`;
              } else if (report.successorUsable) {
                detail = `lane ${lane.id} uses ${concrete}, deprecated ${dateStr} → migrate to ${report.successor} (priced: yes)`;
                fix = `Update the lane's model in lanes.yaml to use successor model "${report.successor}".`;
              } else {
                if (!Object.hasOwn(priceTable.models, report.successor)) {
                  detail = `lane ${lane.id} uses ${concrete}, deprecated ${dateStr} → successor ${report.successor} is not priced — add its price`;
                  fix = `Add successor model "${report.successor}" to the price table to enable migration.`;
                } else {
                  detail = `lane ${lane.id} uses ${concrete}, deprecated ${dateStr} → successor ${report.successor} is unusable — fix config`;
                  fix = `Update the lane's model in lanes.yaml to a non-deprecated model.`;
                }
              }
              findings.push({
                severity: 'warn',
                title: `Lane "${lane.id}" uses a deprecated model`,
                detail,
                fix,
              });
            }
          }
        } catch {
          // fail-open
        }
      }
    }
  }

  return { findings };
}
