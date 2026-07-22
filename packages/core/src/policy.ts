/**
 * Policy engine (C-2): ordered rules + a deny-by-default baseline. Pure, no I/O
 * (YAML file loading lives in the Node adapter).
 *
 * `evaluate` returns a verdict for a (task, lane, context) triple. `routeDecide`
 * uses it to filter candidates BEFORE scoring:
 *   - `allow`          → lane kept.
 *   - `block`          → lane dropped.
 *   - `force-trusted`  → lane kept only if `trust_mode === 'full'`.
 *
 * Deny-by-default: when no rule matches, anything other than a clearly-safe
 * context (public repo + normal sensitivity, no secret) defaults to
 * `force-trusted` — so an unknown/sensitive context never silently routes to a
 * non-`full` lane.
 */

import { parse as parseYaml } from 'yaml';

import { POLICY_VERDICTS, TRUST_MODE_ALIASES, TRUST_MODES } from './types.ts';
import { activeCategories } from './taxonomy.ts';
import type {
  Lane,
  Policy,
  PolicyContext,
  PolicyRule,
  PolicyVerdict,
  RepoClass,
  Sensitivity,
  Task,
  TaskCategory,
} from './types.ts';

const REPO_CLASSES: readonly RepoClass[] = ['public', 'private', 'unknown'];
const SENSITIVITIES: readonly Sensitivity[] = ['normal', 'sensitive', 'unknown'];

/** Raised for malformed/invalid policy configuration, with a clear message. */
export class PolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyConfigError';
  }
}

/** A verdict plus the reason that produced it. */
export interface PolicyDecision {
  verdict: PolicyVerdict;
  reason: string;
}

function matchOne<T>(condition: T | T[] | undefined, value: T): boolean {
  if (condition === undefined) return true;
  return Array.isArray(condition) ? condition.includes(value) : condition === value;
}

function ruleMatches(
  rule: PolicyRule,
  task: Task,
  lane: Lane,
  repoClass: RepoClass,
  sensitivity: Sensitivity,
): boolean {
  return (
    matchOne(rule.repo_class, repoClass) &&
    matchOne(rule.sensitivity, sensitivity) &&
    matchOne(rule.trust_mode, lane.trust_mode) &&
    matchOne(rule.provenance, lane.provenance) &&
    matchOne(rule.jurisdiction, lane.jurisdiction) &&
    matchOne(rule.category, task.category)
  );
}

/**
 * Evaluate the policy for a (task, lane) pair. The first matching ordered rule
 * wins; otherwise the deny-by-default baseline applies.
 */
export function evaluate(
  task: Task,
  lane: Lane,
  ctx: PolicyContext,
  policy: Policy,
  elevated = false,
): PolicyDecision {
  const repoClass: RepoClass = ctx.repo_class ?? 'unknown';
  const sensitivity: Sensitivity = ctx.sensitivity ?? 'unknown';

  let decision: PolicyDecision | undefined;
  for (const rule of policy.rules ?? []) {
    if (ruleMatches(rule, task, lane, repoClass, sensitivity)) {
      decision = { verdict: rule.verdict, reason: rule.reason ?? 'matched policy rule' };
      break;
    }
  }
  if (!decision) {
    // Deny-by-default baseline: only public + normal is clearly safe.
    decision =
      repoClass === 'public' && sensitivity === 'normal'
        ? { verdict: 'allow', reason: 'public repo, normal sensitivity' }
        : {
            verdict: 'force-trusted',
            reason: `deny-by-default (repo_class=${repoClass}, sensitivity=${sensitivity})`,
          };
  }

  // A detected secret can never be `allow`: upgrade to at least force-trusted.
  // A stricter `block` (rule) is preserved — secret only tightens, never loosens.
  if (ctx.secretHit === true && decision.verdict === 'allow') {
    decision = { verdict: 'force-trusted', reason: 'secret detected: trusted/local lanes only' };
  }

  // READER HARD CAP (F-2) — un-overridable by user rules. A `reader` lane may NEVER
  // take an unsafe context: an unknown repo_class, a non-normal sensitivity, or a
  // detected secret. This mirrors the minimizeForReader boundary floor (defense in
  // depth) and cannot be loosened by an explicit `allow` rule. We force-trusted
  // (so only a full lane may take the work) rather than block, unless a rule already
  // blocked it. Reader on a known (public/private) + normal + no-secret context is
  // unaffected — that is the tier's intended use.
  // When elevated is true, reader hard cap ONLY fires if secretHit is true.
  const isHardCapped =
    lane.trust_mode === 'reader' &&
    decision.verdict !== 'block' &&
    (elevated ? ctx.secretHit === true : (sensitivity !== 'normal' || repoClass === 'unknown' || ctx.secretHit === true));

  if (isHardCapped) {
    return {
      verdict: 'force-trusted',
      reason: 'reader hard cap: reader lanes require a known repo + normal sensitivity + no secret',
    };
  }
  return decision;
}

/** Whether a lane survives a verdict (used by routing to filter candidates). */
export function laneAllowedByVerdict(lane: Lane, verdict: PolicyVerdict): boolean {
  if (verdict === 'block') return false;
  if (verdict === 'force-trusted') return lane.trust_mode === 'full';
  return true; // allow
}

// ---- config parsing / validation ----------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ALLOWED_RULE_KEYS = new Set([
  'repo_class',
  'sensitivity',
  'trust_mode',
  'provenance',
  'jurisdiction',
  'category',
  'verdict',
  'reason',
]);

function validateCondition<T extends string>(
  value: unknown,
  allowed: readonly T[] | null,
  where: string,
): T | T[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (typeof v !== 'string' || (allowed !== null && !allowed.includes(v as T))) {
      const suffix = allowed ? ` Valid: ${allowed.join(', ')}.` : '';
      throw new PolicyConfigError(`${where} has invalid value ${JSON.stringify(v)}.${suffix}`);
    }
  }
  return value as T | T[];
}

function parseRule(entry: unknown, index: number): PolicyRule {
  const where = `rules[${index}]`;
  if (!isPlainObject(entry)) {
    throw new PolicyConfigError(`${where} must be a mapping.`);
  }
  for (const key of Object.keys(entry)) {
    if (!ALLOWED_RULE_KEYS.has(key)) {
      throw new PolicyConfigError(
        `${where} has unknown field "${key}". Allowed: ${[...ALLOWED_RULE_KEYS].join(', ')}.`,
      );
    }
  }
  if (typeof entry.verdict !== 'string' || !POLICY_VERDICTS.includes(entry.verdict as PolicyVerdict)) {
    throw new PolicyConfigError(
      `${where}.verdict must be one of: ${POLICY_VERDICTS.join(', ')} (got ${JSON.stringify(entry.verdict)}).`,
    );
  }
  if (entry.reason !== undefined && typeof entry.reason !== 'string') {
    throw new PolicyConfigError(`${where}.reason must be a string.`);
  }
  const rule: PolicyRule = { verdict: entry.verdict as PolicyVerdict };
  const repo_class = validateCondition(entry.repo_class, REPO_CLASSES, `${where}.repo_class`);
  const sensitivity = validateCondition(entry.sensitivity, SENSITIVITIES, `${where}.sensitivity`);
  // Normalize deprecated trust-mode aliases (e.g. `monitored` → `reader`) so old
  // policies keep loading; matches the lane-config parser.
  const aliasTrust = (v: unknown): unknown =>
    typeof v === 'string' && v in TRUST_MODE_ALIASES ? TRUST_MODE_ALIASES[v] : v;
  const rawTrust = Array.isArray(entry.trust_mode) ? entry.trust_mode.map(aliasTrust) : aliasTrust(entry.trust_mode);
  const trust_mode = validateCondition(rawTrust, TRUST_MODES, `${where}.trust_mode`);
  const provenance = validateCondition(entry.provenance, null, `${where}.provenance`);
  const jurisdiction = validateCondition(entry.jurisdiction, null, `${where}.jurisdiction`);
  const category = validateCondition(entry.category, activeCategories(), `${where}.category`);
  if (repo_class !== undefined) rule.repo_class = repo_class as PolicyRule['repo_class'];
  if (sensitivity !== undefined) rule.sensitivity = sensitivity as PolicyRule['sensitivity'];
  if (trust_mode !== undefined) rule.trust_mode = trust_mode as PolicyRule['trust_mode'];
  if (provenance !== undefined) rule.provenance = provenance as PolicyRule['provenance'];
  if (jurisdiction !== undefined) rule.jurisdiction = jurisdiction as PolicyRule['jurisdiction'];
  if (category !== undefined) rule.category = category as TaskCategory | TaskCategory[];
  if (typeof entry.reason === 'string') rule.reason = entry.reason;
  return rule;
}

/** Parse and validate a `policy.yaml` string into a {@link Policy}. */
export function parsePolicyConfig(text: string): Policy {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PolicyConfigError(`Could not parse policy config as YAML: ${detail}`);
  }
  // An empty document is a valid (rule-less) policy ⇒ pure deny-by-default.
  if (doc === null || doc === undefined) return { rules: [] };
  if (!isPlainObject(doc)) {
    throw new PolicyConfigError('Policy config must be a mapping with an optional "rules" array.');
  }
  for (const key of Object.keys(doc)) {
    if (key !== 'rules' && key !== 'disabledLaneIds') {
      throw new PolicyConfigError(
        `Policy config has unknown top-level field "${key}". Allowed: rules, disabledLaneIds.`,
      );
    }
  }
  const result: Policy = { rules: [] };
  if (doc.rules !== undefined) {
    if (!Array.isArray(doc.rules)) {
      throw new PolicyConfigError('Policy config "rules" must be an array.');
    }
    result.rules = doc.rules.map((entry, i) => parseRule(entry, i));
  }
  if (doc.disabledLaneIds !== undefined) {
    if (!Array.isArray(doc.disabledLaneIds) || doc.disabledLaneIds.some((x) => typeof x !== 'string')) {
      throw new PolicyConfigError('Policy config "disabledLaneIds" must be an array of strings.');
    }
    result.disabledLaneIds = doc.disabledLaneIds as string[];
  }
  return result;
}
