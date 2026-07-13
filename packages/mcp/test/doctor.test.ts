import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runDoctor } from '../src/doctor.ts';
import { reportFreshness, reportModelIdMismatches } from '../src/freshness-report.ts';
import { readFreshnessCache } from '../src/model-cache.ts';
import { loadLaneConfig } from '@tokenmaxed/core/node';

// Helper to create a temp config environment
function createTempConfigs(lanesContent: string, policyContent: string, settingsContent?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tm-doctor-test-'));
  const lanesPath = join(dir, 'lanes.yaml');
  const policyPath = join(dir, 'policy.yaml');

  writeFileSync(lanesPath, lanesContent, 'utf8');
  writeFileSync(policyPath, policyContent, 'utf8');

  let settingsPath: string | undefined;
  if (settingsContent !== undefined) {
    settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, settingsContent, 'utf8');
  }

  return { dir, lanesPath, policyPath, settingsPath };
}

// Helper to get recursive file state (modification times + existence)
function getDirState(dirPath: string): Record<string, number> {
  const state: Record<string, number> = {};
  const traverse = (currentDir: string) => {
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          traverse(fullPath);
        } else {
          state[fullPath] = statSync(fullPath).mtimeMs;
        }
      }
    } catch {
      // ignore
    }
  };
  traverse(dirPath);
  return state;
}

test('runDoctor writes NO files (strict read-only / immutability)', async () => {
  const lanesYaml = `
lanes:
  - id: api-lane
    kind: api
    model: claude-3
    trust_mode: full
    costBasis: metered
    provenance: anthropic
    jurisdiction: US
    authHandle: ANTHROPIC
    endpoint: https://api.anthropic.com
`;
  const policyYaml = 'rules: []';
  const { dir, lanesPath, policyPath } = createTempConfigs(lanesYaml, policyYaml);

  const env = {
    TOKENMAXED_LANES: lanesPath,
    TOKENMAXED_POLICY: policyPath,
    TOKENMAXED_MODEL_CACHE: join(dir, 'model-freshness.json'),
  };

  const realDeps = {
    freshness: async () => {
      const registry = loadLaneConfig(lanesPath);
      const eligible = registry.lanes.filter(
        (l) => l.kind === 'api' && l.trust_mode !== 'blocked' && !!l.authHandle
      );
      return reportFreshness(
        eligible,
        {
          fetchList: () => { throw new Error('egress not allowed'); },
          table: { schema_version: 1, frontier_model: 'f', models: {} },
          now: Date.now(),
          readCache: () => readFreshnessCache(env.TOKENMAXED_MODEL_CACHE),
          writeCache: () => {},
        },
        { refresh: false },
      );
    },
    idMismatch: async () => {
      const registry = loadLaneConfig(lanesPath);
      const eligible = registry.lanes.filter(
        (l) => l.kind === 'api' && l.trust_mode !== 'blocked' && !!l.authHandle
      );
      return reportModelIdMismatches(eligible, {
        table: { schema_version: 1, frontier_model: 'f', models: {} },
        now: Date.now(),
        ttlMs: 10 * 60_000,
        readCache: () => readFreshnessCache(env.TOKENMAXED_MODEL_CACHE),
      });
    }
  };

  const beforeState = getDirState(dir);
  await runDoctor(env, realDeps);
  const afterState = getDirState(dir);

  assert.deepEqual(beforeState, afterState, 'No files should be created or modified by runDoctor');
});

test('runDoctor does not leak secret token from YAML parse errors', async () => {
  const lanesYaml = `
lanes:
  - id: secret-lane
    kind: api
    model: gpt-4
    trust_mode: full
    costBasis: metered
    provenance: openai
    jurisdiction: US
    authHandle: [sk-live-SECRET-KEY-12345-ABCDE]
`;
  const { lanesPath, policyPath } = createTempConfigs(lanesYaml, 'rules: []');
  const env = {
    TOKENMAXED_LANES: lanesPath,
    TOKENMAXED_POLICY: policyPath,
  };

  const report = await runDoctor(env, {});
  const errorFindings = report.findings.filter((f) => f.severity === 'error');
  assert.ok(errorFindings.length > 0);

  for (const f of report.findings) {
    assert.ok(!f.detail.includes('sk-live-SECRET'), 'YAML parse error leaked API key secret');
    assert.ok(!f.fix.includes('sk-live-SECRET'), 'YAML parse error leaked API key secret in fix');
  }
});

test('runDoctor detects malformed settings.json', async () => {
  const { lanesPath, policyPath, settingsPath } = createTempConfigs(
    'lanes: []',
    'rules: []',
    'invalid-json-structure {'
  );

  const env = {
    TOKENMAXED_LANES: lanesPath,
    TOKENMAXED_POLICY: policyPath,
    TOKENMAXED_SETTINGS: settingsPath!,
  };

  const report = await runDoctor(env, {});
  const warnFindings = report.findings.filter((f) => f.severity === 'warn');
  assert.ok(warnFindings.some((w) => w.title.includes('Settings configuration is malformed')));
});

test('runDoctor reports indeterminate findings on probe failures', async () => {
  const lanesYaml = `
lanes:
  - id: active-reviewer
    kind: cli
    model: claude-native
    trust_mode: full
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    command: node
    manager_allowed: true
    native: true
`;
  const { lanesPath, policyPath } = createTempConfigs(lanesYaml, 'rules: []');
  const env = {
    TOKENMAXED_LANES: lanesPath,
    TOKENMAXED_POLICY: policyPath,
  };

  const failingDeps = {
    freshness: async () => {
      throw new Error('Freshness probe network timeout');
    },
    idMismatch: async () => {
      throw new Error('Cache read failure');
    },
  };

  const report = await runDoctor(env, failingDeps);
  const indeterminate = report.findings.filter((f) => f.title.includes("Couldn't determine"));
  assert.ok(indeterminate.some((i) => i.title.includes('model freshness')));
  assert.ok(indeterminate.some((i) => i.title.includes('model ID casing status')));
});

test('healthy native-only config yields no spurious errors/warnings', async () => {
  const lanesYaml = `
lanes:
  - id: claude-native
    kind: cli
    model: claude-native
    trust_mode: full
    costBasis: subscription
    provenance: anthropic
    jurisdiction: US
    command: node
    manager_allowed: true
    native: true
`;
  const { lanesPath, policyPath } = createTempConfigs(lanesYaml, 'rules: []');
  const env = {
    TOKENMAXED_LANES: lanesPath,
    TOKENMAXED_POLICY: policyPath,
  };

  const report = await runDoctor(env, {});
  const problems = report.findings.filter((f) => f.severity === 'error' || f.severity === 'warn');
  const realProblems = problems.filter((f) => !f.title.includes('gitleaks') && !f.title.includes('duplicate plugin'));
  assert.equal(realProblems.length, 0, `Expected no problems, got: ${JSON.stringify(realProblems)}`);
});

test('severity matches spec: warns for single unavailable lane, errors if all non-native are down', async () => {
  const lanesYaml = `
lanes:
  - id: missing-cli-1
    kind: cli
    model: custom-1
    trust_mode: full
    costBasis: subscription
    provenance: openai
    jurisdiction: US
    command: /nonexistent/binary-1
  - id: missing-cli-2
    kind: cli
    model: custom-2
    trust_mode: full
    costBasis: subscription
    provenance: openai
    jurisdiction: US
    command: /nonexistent/binary-2
`;
  const { lanesPath, policyPath } = createTempConfigs(lanesYaml, 'rules: []');
  const env = {
    TOKENMAXED_LANES: lanesPath,
    TOKENMAXED_POLICY: policyPath,
  };

  const report = await runDoctor(env, {});
  const errors = report.findings.filter((f) => f.severity === 'error');
  const warnings = report.findings.filter((f) => f.severity === 'warn');

  assert.ok(errors.some((e) => e.title.includes('No runnable non-native lanes available')));
  assert.ok(warnings.some((w) => w.title.includes('Lane "missing-cli-1" is unavailable')));
  assert.ok(warnings.some((w) => w.title.includes('Lane "missing-cli-2" is unavailable')));
});

test('runDoctor findings ordering is deterministic (registry order)', async () => {
  const lanesYaml = `
lanes:
  - id: lane-first
    kind: api
    model: claude-first
    trust_mode: full
    costBasis: metered
    provenance: anthropic
    jurisdiction: US
    authHandle: ANTHROPIC
    endpoint: https://api.anthropic.com
  - id: lane-second
    kind: api
    model: claude-second
    trust_mode: full
    costBasis: metered
    provenance: anthropic
    jurisdiction: US
    authHandle: ANTHROPIC
    endpoint: https://api.anthropic.com
`;
  const { lanesPath, policyPath } = createTempConfigs(lanesYaml, 'rules: []');
  const env = {
    TOKENMAXED_LANES: lanesPath,
    TOKENMAXED_POLICY: policyPath,
  };

  const report1 = await runDoctor(env, {});
  const idxFirst = report1.findings.findIndex((f) => f.title.includes('lane-first'));
  const idxSecond = report1.findings.findIndex((f) => f.title.includes('lane-second'));

  assert.ok(idxFirst >= 0);
  assert.ok(idxSecond >= 0);
  assert.ok(idxFirst < idxSecond, 'Findings same-severity ordering should be in registry order');
});

test('runDoctor reports missing files', async () => {
  const env = {
    TOKENMAXED_LANES: '/nonexistent/lanes.yaml',
    TOKENMAXED_POLICY: '/nonexistent/policy.yaml',
  };

  const report = await runDoctor(env, {});
  const errors = report.findings.filter((f) => f.severity === 'error');
  assert.ok(errors.some((e) => e.title.includes('Lanes configuration file missing')));
  assert.ok(errors.some((e) => e.title.includes('Policy configuration file missing')));
});

test('runDoctor reports malformed config with a fix', async () => {
  const { lanesPath, policyPath } = createTempConfigs(
    'invalid-yaml-structure: {',
    'rules: ['
  );

  const env = {
    TOKENMAXED_LANES: lanesPath,
    TOKENMAXED_POLICY: policyPath,
  };

  const report = await runDoctor(env, {});
  const errors = report.findings.filter((f) => f.severity === 'error');
  assert.ok(errors.some((e) => e.title.includes('Lanes configuration is malformed')));
  assert.ok(errors.some((e) => e.title.includes('Policy configuration is malformed')));
});

test('runDoctor reports missing manager and missing gitleaks', async () => {
  const lanesYaml = `
lanes:
  - id: gpt-worker
    kind: api
    model: gpt-4o
    trust_mode: worker
    costBasis: metered
    provenance: openai
    jurisdiction: US
    authHandle: OPENAI
    endpoint: https://api.openai.com/v1
`;
  const policyYaml = 'rules: []';

  const { lanesPath, policyPath } = createTempConfigs(lanesYaml, policyYaml);
  const originalPath = process.env.PATH;
  process.env.PATH = ''; // ensures gitleaks fails
  try {
    const env = {
      TOKENMAXED_LANES: lanesPath,
      TOKENMAXED_POLICY: policyPath,
    };

    const report = await runDoctor(env, {});
    const warnings = report.findings.filter((f) => f.severity === 'warn');

    assert.ok(warnings.some((w) => w.title.includes('No manager/reviewer lane configured')));
    assert.ok(warnings.some((w) => w.title.includes('Secret scanner (gitleaks) not installed')));
  } finally {
    process.env.PATH = originalPath;
  }
});

test('runDoctor with real deps handles missing/stale cache and produces indeterminate findings', async () => {
  const lanesYaml = `
lanes:
  - id: api-lane
    kind: api
    model: claude-3
    trust_mode: full
    costBasis: metered
    provenance: anthropic
    jurisdiction: US
    authHandle: ANTHROPIC
    endpoint: https://api.anthropic.com
`;
  const { lanesPath, policyPath } = createTempConfigs(lanesYaml, 'rules: []');

  // We explicitly do NOT create the model-freshness.json cache file.
  const env = {
    TOKENMAXED_LANES: lanesPath,
    TOKENMAXED_POLICY: policyPath,
    TOKENMAXED_MODEL_CACHE: join(dirname(lanesPath), 'model-freshness.json'),
  };

  const realDeps = {
    freshness: async () => {
      const registry = loadLaneConfig(lanesPath);
      const eligible = registry.lanes.filter(
        (l) => l.kind === 'api' && l.trust_mode !== 'blocked' && !!l.authHandle
      );
      return reportFreshness(
        eligible,
        {
          fetchList: () => { throw new Error('egress not allowed'); },
          table: { schema_version: 1, frontier_model: 'f', models: {} },
          now: Date.now(),
          readCache: () => readFreshnessCache(env.TOKENMAXED_MODEL_CACHE),
          writeCache: () => {},
        },
        { refresh: false },
      );
    },
    idMismatch: async () => {
      const registry = loadLaneConfig(lanesPath);
      const eligible = registry.lanes.filter(
        (l) => l.kind === 'api' && l.trust_mode !== 'blocked' && !!l.authHandle
      );
      return reportModelIdMismatches(eligible, {
        table: { schema_version: 1, frontier_model: 'f', models: {} },
        now: Date.now(),
        ttlMs: 10 * 60_000,
        readCache: () => readFreshnessCache(env.TOKENMAXED_MODEL_CACHE),
      });
    }
  };

  const report = await runDoctor(env, realDeps);

  // Assert we get the indeterminate findings
  const warnFindings = report.findings.filter((f) => f.severity === 'warn');
  assert.ok(warnFindings.some((w) => w.title.includes('Model freshness not verified for lane "api-lane"')));
  assert.ok(warnFindings.some((w) => w.title.includes('Model ID casing validation not verified for lane "api-lane"')));
});

test('runDoctor with real deps handles malformed/stale/unreadable caches and missing endpoint', async () => {
  const lanesYaml = `
lanes:
  - id: api-lane-1
    kind: api
    model: claude-3
    trust_mode: full
    costBasis: metered
    provenance: anthropic
    jurisdiction: US
    authHandle: ANTHROPIC
    endpoint: https://api.anthropic.com
  - id: api-lane-2
    kind: api
    model: gpt-4
    trust_mode: full
    costBasis: metered
    provenance: openai
    jurisdiction: US
    authHandle: OPENAI
    native: true
`;
  const { lanesPath, policyPath, dir } = createTempConfigs(lanesYaml, 'rules: []');

  // Helper to make realDeps with custom cache path/reading
  const makeRealDeps = (cacheFile: string) => ({
    freshness: async () => {
      const registry = loadLaneConfig(lanesPath);
      const eligible = registry.lanes.filter(
        (l) => l.kind === 'api' && l.trust_mode !== 'blocked' && !!l.authHandle
      );
      return reportFreshness(
        eligible,
        {
          fetchList: () => { throw new Error('egress not allowed'); },
          table: { schema_version: 1, frontier_model: 'f', models: {} },
          now: 50_000,
          readCache: () => readFreshnessCache(cacheFile),
          writeCache: () => {},
        },
        { refresh: false },
      );
    },
    idMismatch: async () => {
      const registry = loadLaneConfig(lanesPath);
      const eligible = registry.lanes.filter(
        (l) => l.kind === 'api' && l.trust_mode !== 'blocked' && !!l.authHandle
      );
      return reportModelIdMismatches(eligible, {
        table: { schema_version: 1, frontier_model: 'f', models: {} },
        now: 50_000,
        ttlMs: 10_000, // 10s TTL
        readCache: () => readFreshnessCache(cacheFile),
      });
    }
  });

  // 1. Endpoint-less lane check
  const envNoCache = {
    TOKENMAXED_LANES: lanesPath,
    TOKENMAXED_POLICY: policyPath,
    TOKENMAXED_MODEL_CACHE: join(dir, 'nonexistent-cache.json'),
  };
  const report1 = await runDoctor(envNoCache, makeRealDeps(envNoCache.TOKENMAXED_MODEL_CACHE));
  const warn1 = report1.findings.filter((f) => f.severity === 'warn');
  assert.ok(warn1.some((w) => w.title.includes('Lane "api-lane-2" has no endpoint')));
  assert.ok(warn1.some((w) => w.title.includes('Model freshness not verified for lane "api-lane-1"')));
  assert.ok(warn1.some((w) => w.title.includes('Model ID casing validation not verified for lane "api-lane-1"')));

  // 2. Malformed cache check
  const malformedCacheFile = join(dir, 'malformed-cache.json');
  writeFileSync(malformedCacheFile, 'invalid-json-structure {', 'utf8');
  const envMalformed = {
    TOKENMAXED_LANES: lanesPath,
    TOKENMAXED_POLICY: policyPath,
    TOKENMAXED_MODEL_CACHE: malformedCacheFile,
  };
  const report2 = await runDoctor(envMalformed, makeRealDeps(malformedCacheFile));
  const warn2 = report2.findings.filter((f) => f.severity === 'warn');
  assert.ok(warn2.some((w) => w.title.includes('Model freshness not verified for lane "api-lane-1"')));
  assert.ok(warn2.some((w) => w.title.includes('Model ID casing validation not verified for lane "api-lane-1"')));

  // 3. Stale cache check (checkedAt is older than TTL of 10s)
  const staleCacheFile = join(dir, 'stale-cache.json');
  const staleCacheData = {
    version: 1,
    endpoints: {
      'https://api.anthropic.com': {
        models: [{ id: 'claude-3' }],
        checkedAt: 1000, // checked at t=1000, now is 50,000, TTL is 10,000 => stale!
      }
    }
  };
  writeFileSync(staleCacheFile, JSON.stringify(staleCacheData), 'utf8');
  const envStale = {
    TOKENMAXED_LANES: lanesPath,
    TOKENMAXED_POLICY: policyPath,
    TOKENMAXED_MODEL_CACHE: staleCacheFile,
  };
  const report3 = await runDoctor(envStale, makeRealDeps(staleCacheFile));
  const warn3 = report3.findings.filter((f) => f.severity === 'warn');
  assert.ok(warn3.some((w) => w.title.includes('Model freshness not verified for lane "api-lane-1"')));
  assert.ok(warn3.some((w) => w.title.includes('Model ID casing validation not verified for lane "api-lane-1"')));

  // 4. Unreadable cache check (throws on read)
  const failingDeps = {
    freshness: async () => {
      throw new Error('IO / Read failure');
    },
    idMismatch: async () => {
      throw new Error('IO / Read failure');
    }
  };
  const report4 = await runDoctor(envNoCache, failingDeps);
  const warn4 = report4.findings.filter((f) => f.severity === 'warn');
  assert.ok(warn4.some((w) => w.title.includes("Couldn't determine model freshness")));
  assert.ok(warn4.some((w) => w.title.includes("Couldn't determine model ID casing status")));
});

test('runDoctor with real deps handles mixed covered and uncovered lanes', async () => {
  const lanesYaml = `
lanes:
  - id: api-covered
    kind: api
    model: gpt-3.5-turbo
    trust_mode: full
    costBasis: metered
    provenance: openai
    jurisdiction: US
    authHandle: OPENAI
    endpoint: https://api.openai.com/v1
  - id: api-uncovered
    kind: api
    model: claude-3
    trust_mode: full
    costBasis: metered
    provenance: anthropic
    jurisdiction: US
    authHandle: ANTHROPIC
    endpoint: https://api.anthropic.com
`;
  const { lanesPath, policyPath, dir } = createTempConfigs(lanesYaml, 'rules: []');

  const cacheFile = join(dir, 'mixed-cache.json');
  const env = {
    TOKENMAXED_LANES: lanesPath,
    TOKENMAXED_POLICY: policyPath,
    TOKENMAXED_MODEL_CACHE: cacheFile,
  };

  const mixedDeps = {
    freshness: async () => {
      return [{ laneId: 'api-covered', family: 'gpt-3', pinned: 'gpt-3.5-turbo', newest: 'gpt-4', newestPriced: true }];
    },
    idMismatch: async () => {
      return [{ laneId: 'api-covered', sent: 'gpt-3.5-turbo', vendorId: 'GPT-3.5-Turbo' }];
    }
  };

  // We write cache containing a current entry for api-covered only!
  const cacheData = {
    version: 1,
    endpoints: {
      'https://api.openai.com/v1': {
        models: [{ id: 'gpt-3.5-turbo' }, { id: 'gpt-4' }],
        checkedAt: 50_000,
      }
    }
  };
  writeFileSync(cacheFile, JSON.stringify(cacheData), 'utf8');

  const originalNow = Date.now;
  Date.now = () => 50_000;
  try {
    const report = await runDoctor(env, mixedDeps);
    const warnings = report.findings.filter((f) => f.severity === 'warn');

    // Covered lane's real warnings are present
    assert.ok(warnings.some((w) => w.title.includes('Stale model ID pinned for lane "api-covered"')));
    assert.ok(warnings.some((w) => w.title.includes('Model ID casing/existence mismatch for lane "api-covered"')));

    // Uncovered lane's indeterminate warnings are present
    assert.ok(warnings.some((w) => w.title.includes('Model freshness not verified for lane "api-uncovered"')));
    assert.ok(warnings.some((w) => w.title.includes('Model ID casing validation not verified for lane "api-uncovered"')));
  } finally {
    Date.now = originalNow;
  }
});
