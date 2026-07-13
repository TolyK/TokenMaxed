/**
 * A4 — persistent, visible settings (`~/.tokenmaxed/settings.json`) for the
 * opt-in feature flags that previously lived ONLY in launch-time env vars.
 *
 * Model: the settings file provides DEFAULTS for a fixed allowlist of
 * `TOKENMAXED_*` flag vars; a real environment variable always WINS (per-launch
 * overrides keep working exactly as documented). `effectiveEnv()` merges the
 * two into a plain env object, so every existing consumer (server, setup,
 * hooks, statusline) works unchanged — one wrap at each entrypoint, no
 * per-flag plumbing.
 *
 * Deliberately NOT settable here (safety):
 *  - `TOKENMAXED_DISABLE` — the kill-switch stays explicit env-only.
 *  - `TOKENMAXED_YOLO` — the dangerous mode keeps its own explicit env default
 *    + per-project runtime toggle (/tokenmaxed:yolo).
 *  - `TOKENMAXED_KEY_<handle>` / any secret — credentials stay in the
 *    environment; the allowlist makes injection through this file impossible.
 *
 * Strict JSON (like Claude Code's own settings.json), user-owned location
 * (same trust class as lanes.yaml — never read from the repo). Fail-open: a
 * missing/corrupt file changes nothing; the parse error is surfaced through
 * the report (router_config / setup), never thrown at a consumer.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { homeFile } from './config.ts';

/** Settings keys → the env var each one defaults. Booleans unless noted. */
export const SETTING_KEYS = {
  gate_ready: 'TOKENMAXED_GATE_READY',
  escalate: 'TOKENMAXED_ESCALATE',
  learn_capability: 'TOKENMAXED_LEARN_CAPABILITY',
  capability_prior: 'TOKENMAXED_CAPABILITY_PRIOR',
  reader_egress: 'TOKENMAXED_READER_EGRESS',
  tiered: 'TOKENMAXED_TIERED',
  /** number in [0,1] */
  tier_floor: 'TOKENMAXED_TIER_FLOOR',
  review_on_stop: 'TOKENMAXED_REVIEW_ON_STOP',
  /** positive integer */
  review_max_rounds: 'TOKENMAXED_REVIEW_MAX_ROUNDS',
  lane_health: 'TOKENMAXED_LANE_HEALTH',
} as const;

export type SettingKey = keyof typeof SETTING_KEYS;
export const SETTING_KEY_LIST = Object.keys(SETTING_KEYS) as readonly SettingKey[];
const NUMERIC_KEYS: ReadonlySet<SettingKey> = new Set(['tier_floor', 'review_max_rounds'] as const);

/** Where the settings file lives (env-overridable for tests, like every path). */
export function settingsPath(env: NodeJS.ProcessEnv): string {
  return env.TOKENMAXED_SETTINGS ?? homeFile('settings.json');
}

/** A validated value for a key, or undefined when absent/invalid. */
function validValue(key: SettingKey, raw: unknown): boolean | number | undefined {
  if (NUMERIC_KEYS.has(key)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
    if (key === 'tier_floor' && (raw < 0 || raw > 1)) return undefined;
    if (key === 'review_max_rounds' && (!Number.isInteger(raw) || raw < 1)) return undefined;
    return raw;
  }
  return typeof raw === 'boolean' ? raw : undefined;
}

interface LoadedSettings {
  /** Validated known key → value. */
  values: Partial<Record<SettingKey, boolean | number>>;
  /** One-line problem description (parse error / non-object), if any. */
  warning?: string;
  /** Whether the file exists at all. */
  present: boolean;
  /** Known keys present in the file but with an invalid type/range (ignored). */
  invalid: string[];
}

/** Read + validate the settings file. Never throws. */
export function loadSettings(env: NodeJS.ProcessEnv): LoadedSettings {
  const path = settingsPath(env);
  if (!existsSync(path)) return { values: {}, present: false, invalid: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { values: {}, present: true, invalid: [], warning: `settings unreadable (${path}): ${(err as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { values: {}, present: true, invalid: [], warning: `settings must be a JSON object (${path})` };
  }
  const obj = parsed as Record<string, unknown>;
  const values: LoadedSettings['values'] = {};
  const invalid: string[] = [];
  for (const key of SETTING_KEY_LIST) {
    if (!(key in obj)) continue;
    const v = validValue(key, obj[key]);
    if (v === undefined) invalid.push(key);
    else values[key] = v;
  }
  return { values, present: true, invalid };
}

/**
 * Provenance ledger: WHICH keys effectiveEnv() seeded into WHICH returned env
 * object. Kept OUT-OF-BAND in process memory (keyed by the exact object
 * identity) so provenance cannot be asserted by anything in the environment
 * itself — a raw env carrying any marker/values can never masquerade as
 * settings-seeded. Consumers that report provenance (settingsReport) run in
 * the same process as the wrap (server, hooks, statusline), so the WeakMap is
 * always reachable where it matters; a serialized/spawned env simply loses
 * provenance and every set var honestly reports 'env'.
 */
const SEEDED_KEYS = new WeakMap<NodeJS.ProcessEnv, ReadonlySet<SettingKey>>();

/**
 * The merged environment: settings fill ONLY the allowlisted flag vars that the
 * real environment leaves unset. Returns a NEW object; never mutates `env`.
 * Idempotent: wrapping an already-wrapped env changes no values (seeded vars
 * are set, so they win like real ones) and carries the provenance forward.
 */
export function effectiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { values } = loadSettings(env);
  const out: NodeJS.ProcessEnv = { ...env };
  const seeded = new Set<SettingKey>(SEEDED_KEYS.get(env) ?? []);
  for (const key of SETTING_KEY_LIST) {
    const envVar = SETTING_KEYS[key];
    if (out[envVar] !== undefined) continue; // a real env var always wins
    const v = values[key];
    if (v === undefined) continue;
    out[envVar] = String(v);
    seeded.add(key);
  }
  if (seeded.size > 0) SEEDED_KEYS.set(out, seeded);
  return out;
}

/** One row of the effective-config report. */
export interface SettingRow {
  key: SettingKey;
  envVar: string;
  /** The effective string value the consumers see ('' when fully unset). */
  effective: string;
  source: 'env' | 'settings' | 'default';
}

export interface SettingsReport {
  path: string;
  present: boolean;
  warning?: string;
  invalid: string[];
  rows: SettingRow[];
}

/** Per-key effective value + which layer supplied it (for router_config/setup). */
export function settingsReport(env: NodeJS.ProcessEnv): SettingsReport {
  const loaded = loadSettings(env);
  // Works over BOTH a raw env and an effectiveEnv()-wrapped one. Provenance
  // comes from the in-process WeakMap (unforgeable — nothing IN the env can
  // assert it), AND the settings file must still produce the exact value the
  // env carries (so a wrapped-then-mutated var honestly reports 'env').
  const seeded = SEEDED_KEYS.get(env);
  const seededByFile = (key: SettingKey, envValue: string): boolean =>
    seeded !== undefined && seeded.has(key) && loaded.values[key] !== undefined && String(loaded.values[key]) === envValue;
  const rows: SettingRow[] = SETTING_KEY_LIST.map((key) => {
    const envVar = SETTING_KEYS[key];
    if (env[envVar] !== undefined) {
      return { key, envVar, effective: env[envVar]!, source: seededByFile(key, env[envVar]!) ? 'settings' : 'env' };
    }
    const v = loaded.values[key];
    if (v !== undefined) return { key, envVar, effective: String(v), source: 'settings' };
    return { key, envVar, effective: '', source: 'default' };
  });
  return { path: settingsPath(env), present: loaded.present, ...(loaded.warning ? { warning: loaded.warning } : {}), invalid: loaded.invalid, rows };
}

/**
 * Write (or clear, with `value === null`) ONE known setting, preserving every
 * other key in the file byte-for-byte semantically (read-modify-write of the
 * parsed object; unknown keys are kept untouched). Creates the file/dir on
 * first write. Throws on an unwritable path — the caller (router_config)
 * surfaces that as a tool error.
 */
export function writeSetting(env: NodeJS.ProcessEnv, key: SettingKey, value: boolean | number | null): void {
  const path = settingsPath(env);
  let obj: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // Corrupt file: do NOT silently destroy user content on a set — refuse.
      throw new Error(`refusing to overwrite unreadable settings at ${path} — fix or delete it first`);
    }
    // Valid JSON but not an object ([], "text", null…): loadSettings treats it
    // as malformed, so the writer must refuse too — never silently replace
    // user-owned content with a fresh object.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`refusing to overwrite non-object settings at ${path} — fix or delete it first`);
    }
    obj = parsed as Record<string, unknown>;
  }
  if (value === null) delete obj[key];
  else {
    const valid = validValue(key, value);
    if (valid === undefined) throw new Error(`invalid value for "${key}": ${JSON.stringify(value)}`);
    obj[key] = valid;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
