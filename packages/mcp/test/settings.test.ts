/**
 * A4 — persistent settings: the loader's validation, effectiveEnv's
 * env-always-wins merge + provenance marker, settingsReport source
 * attribution over raw AND wrapped envs, writeSetting round-trips, and the
 * router_config tool surface.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  eligibleLanes,
  evaluate,
  hostAllowsLane,
  modelMatchesPin,
  filterEventsSince,
  routeDecide,
  summarize,
  tokenStats,
  TASK_CATEGORIES,
  classifyTask,
  MIN_CLASSIFY_CONFIDENCE,
  CLASSIFY_FALLBACK_CATEGORY,
} from '../../core/src/index.ts';

import { makeServerDeps } from '../src/server.ts';
import { effectiveEnv, loadSettings, settingsReport, writeSetting } from '../src/settings.ts';
import { createTools, dispatch } from '../src/tools.ts';
import type { CorePort } from '../src/tools.ts';

const CORE: CorePort = {
  filterEventsSince,
  summarize,
  tokenStats,
  routeDecide,
  eligibleLanes,
  evaluate,
  hostAllowsLane,
  modelMatchesPin,
  taskCategories: TASK_CATEGORIES,
  classifyTask,
  MIN_CLASSIFY_CONFIDENCE,
  CLASSIFY_FALLBACK_CATEGORY,
  assessDeprecation: () => ({ status: 'ok' }),
  resolveDeprecatedModel: (l: any) => ({ lane: l }),
};
const TOOLS = createTools(CORE);

function tempSettings(content?: string): { dir: string; path: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-settings-'));
  const path = join(dir, 'settings.json');
  if (content !== undefined) writeFileSync(path, content, 'utf8');
  return { dir, path, env: { TOKENMAXED_SETTINGS: path } };
}

test('loadSettings: missing file ⇒ empty, not-present; corrupt ⇒ warning; invalid values listed + ignored', () => {
  const missing = tempSettings();
  try {
    assert.deepEqual(loadSettings(missing.env), { values: {}, present: false, invalid: [] });
  } finally {
    rmSync(missing.dir, { recursive: true, force: true });
  }
  const corrupt = tempSettings('{nope');
  try {
    const s = loadSettings(corrupt.env);
    assert.equal(s.present, true);
    assert.match(s.warning ?? '', /unreadable/);
  } finally {
    rmSync(corrupt.dir, { recursive: true, force: true });
  }
  const mixed = tempSettings(
    JSON.stringify({ escalate: true, tier_floor: 2, review_max_rounds: 0.5, tiered: 'yes', unknown_key: 1 }),
  );
  try {
    const s = loadSettings(mixed.env);
    assert.deepEqual(s.values, { escalate: true }); // tier_floor out of range, rounds non-integer, tiered non-boolean
    assert.deepEqual([...s.invalid].sort(), ['review_max_rounds', 'tier_floor', 'tiered']);
  } finally {
    rmSync(mixed.dir, { recursive: true, force: true });
  }
});

test('effectiveEnv: seeds only UNSET vars, real env always wins, provenance marker set, idempotent', () => {
  const t = tempSettings(JSON.stringify({ escalate: true, tiered: true, tier_floor: 0.7 }));
  try {
    const wrapped = effectiveEnv({ ...t.env, TOKENMAXED_TIERED: 'false' });
    assert.equal(wrapped.TOKENMAXED_ESCALATE, 'true'); // seeded
    assert.equal(wrapped.TOKENMAXED_TIERED, 'false'); // real env wins
    assert.equal(wrapped.TOKENMAXED_TIER_FLOOR, '0.7'); // numeric seeded as string
    const twice = effectiveEnv(wrapped);
    assert.deepEqual(twice, wrapped); // idempotent (values)
    // Provenance survives the double wrap (out-of-band, not an env var).
    assert.equal(settingsReport(twice).rows.find((r) => r.key === 'escalate')?.source, 'settings');
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('effectiveEnv: never seeds the kill-switch, YOLO, or key vars (allowlist only)', () => {
  const t = tempSettings(JSON.stringify({ TOKENMAXED_DISABLE: true, yolo: true, TOKENMAXED_KEY_OPENAI: 'sk-x', escalate: true }));
  try {
    const wrapped = effectiveEnv(t.env);
    assert.equal(wrapped.TOKENMAXED_DISABLE, undefined);
    assert.equal(wrapped.TOKENMAXED_YOLO, undefined);
    assert.equal(wrapped.TOKENMAXED_KEY_OPENAI, undefined);
    assert.equal(wrapped.TOKENMAXED_ESCALATE, 'true');
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('settingsReport: attributes sources correctly over raw AND wrapped envs', () => {
  const t = tempSettings(JSON.stringify({ escalate: true }));
  try {
    const raw = settingsReport({ ...t.env, TOKENMAXED_TIERED: 'true' });
    assert.equal(raw.rows.find((r) => r.key === 'escalate')?.source, 'settings');
    assert.equal(raw.rows.find((r) => r.key === 'tiered')?.source, 'env');
    assert.equal(raw.rows.find((r) => r.key === 'gate_ready')?.source, 'default');
    const wrapped = settingsReport(effectiveEnv({ ...t.env, TOKENMAXED_TIERED: 'true' }));
    assert.equal(wrapped.rows.find((r) => r.key === 'escalate')?.source, 'settings'); // seeded ⇒ still settings
    assert.equal(wrapped.rows.find((r) => r.key === 'tiered')?.source, 'env');
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('writeSetting: creates, preserves unknown keys, clears, validates, refuses corrupt files', () => {
  const t = tempSettings(JSON.stringify({ future_key: 'kept', escalate: false }));
  try {
    writeSetting(t.env, 'escalate', true);
    writeSetting(t.env, 'tier_floor', 0.65);
    const onDisk = JSON.parse(readFileSync(t.path, 'utf8'));
    assert.deepEqual(onDisk, { future_key: 'kept', escalate: true, tier_floor: 0.65 });
    writeSetting(t.env, 'escalate', null);
    assert.equal(JSON.parse(readFileSync(t.path, 'utf8')).escalate, undefined);
    assert.throws(() => writeSetting(t.env, 'tier_floor', 2), /invalid value/);
    writeFileSync(t.path, '{corrupt', 'utf8');
    assert.throws(() => writeSetting(t.env, 'escalate', true), /refusing to overwrite/);
    // Valid JSON but NOT an object: the writer must refuse too, never replace.
    for (const nonObject of ['[]', '"text"', 'null']) {
      writeFileSync(t.path, nonObject, 'utf8');
      assert.throws(() => writeSetting(t.env, 'escalate', true), /refusing to overwrite non-object/);
      assert.equal(readFileSync(t.path, 'utf8'), nonObject); // content untouched
    }
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('settingsReport: provenance is unforgeable — only a genuine effectiveEnv seed reports settings', () => {
  const t = tempSettings(JSON.stringify({ escalate: true }));
  try {
    // A raw env var that HAPPENS to equal the stored value is still 'env':
    // nothing carried IN an env can assert settings provenance (out-of-band WeakMap).
    const coincidence = settingsReport({ ...t.env, TOKENMAXED_ESCALATE: 'true', TOKENMAXED_SETTINGS_APPLIED: 'escalate' });
    assert.equal(coincidence.rows.find((r) => r.key === 'escalate')?.source, 'env');
    // A genuine wrap reports 'settings'.
    assert.equal(settingsReport(effectiveEnv(t.env)).rows.find((r) => r.key === 'escalate')?.source, 'settings');
    // Wrapped-then-mutated var honestly reports 'env' (value no longer from the file).
    const mutated = effectiveEnv(t.env);
    mutated.TOKENMAXED_ESCALATE = 'false';
    assert.equal(settingsReport(mutated).rows.find((r) => r.key === 'escalate')?.source, 'env');
    // A copied env object loses provenance ⇒ honest 'env' (identity-keyed).
    const copied = { ...effectiveEnv(t.env) };
    assert.equal(settingsReport(copied).rows.find((r) => r.key === 'escalate')?.source, 'env');
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('router_config: lists all keys with sources; set + clear round-trip through the tool', async () => {
  const t = tempSettings();
  try {
    const deps = makeServerDeps({ ...t.env, TOKENMAXED_TIERED: 'true' });
    const list = await dispatch(TOOLS, deps, 'router_config', {});
    assert.match(list.content[0]!.text, /tiered = true — env TOKENMAXED_TIERED overrides/);
    assert.match(list.content[0]!.text, /escalate = \(default\)/);
    assert.match(list.content[0]!.text, /Precedence: env var > settings\.json > default/);

    const set = await dispatch(TOOLS, deps, 'router_config', { key: 'escalate', value: 'true' });
    assert.match(set.content[0]!.text, /escalate = true — from settings/);
    assert.equal(JSON.parse(readFileSync(t.path, 'utf8')).escalate, true);

    const cleared = await dispatch(TOOLS, deps, 'router_config', { key: 'escalate', value: 'clear' });
    assert.match(cleared.content[0]!.text, /escalate = \(default\)/);

    const bad = await dispatch(TOOLS, deps, 'router_config', { key: 'escalate', value: 'maybe' });
    assert.equal(bad.isError, true);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test('integration: a settings file turns a flag on through the entrypoint wrap (env still wins)', () => {
  const t = tempSettings(JSON.stringify({ capability_prior: true }));
  try {
    // The entrypoint wrap is what the server/hooks do with process.env.
    const deps = makeServerDeps(effectiveEnv(t.env));
    // capability_prior=true from settings ⇒ the A1 loader reports ON (bundled seed).
    assert.equal(deps.capabilityPrior?.([]).state, 'on');
    // A real env var beats the same key from settings.
    const overridden = makeServerDeps(effectiveEnv({ ...t.env, TOKENMAXED_CAPABILITY_PRIOR: 'false' }));
    assert.equal(overridden.capabilityPrior?.([]).state, 'off');
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});
