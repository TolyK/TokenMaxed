/**
 * The minimizer (C-3): the heart of the no-leak guarantee. Pure — no I/O. The
 * secret scanner is INJECTED (the gitleaks subprocess lives in the Node adapter)
 * so this module never imports `node:*` and stays fully testable.
 *
 * A {@link MinimizedPayload} is nominal: it carries a module-private brand symbol
 * and can ONLY be produced by `minimize()` here. There is no exported
 * constructor, and a guard test bans `as MinimizedPayload` casts elsewhere — so
 * "an untrusted lane only ever receives a minimized payload" is enforceable by
 * type, not convention.
 *
 * Pipeline: validate + enforce limits → deny-by-default on repo-derived content →
 * scrub repo identifiers/paths/urls/emails → secret-scan (injected; unavailable ⇒
 * block) → brand + deep-freeze.
 *
 * What is ENFORCED vs best-effort (be honest):
 *  - ENFORCED no-leak: (1) deny-by-default — repo-derived content is blocked
 *    unless the context is explicitly public+normal; (2) the secret scan blocks on
 *    a hit OR when unavailable; (3) the payload is a bounded, typed shape with
 *    size limits. These are what the guarantee rests on.
 *  - BEST-EFFORT: `scrubText` redacts common absolute paths / remotes / emails.
 *    It cannot perfectly redact arbitrary identifiers (e.g. paths containing
 *    spaces) — it is defense-in-depth, not the boundary. (Tracked: scrub
 *    completeness is a later hardening item.)
 */

import type { RepoClass, Sensitivity, TaskCategory } from './types.ts';
import { TASK_CATEGORIES } from './types.ts';

/** Module-private brand — not exported, so no other module can construct a payload. */
const BRAND: unique symbol = Symbol('MinimizedPayload');

/**
 * Runtime registry of genuine payloads — the REAL boundary. The type brand alone
 * is copyable by object spread (`{ ...payload, instruction: rawRepoText }`), so
 * the untrusted executor (C-4) must verify {@link isMinimizedPayload} at runtime:
 * a spread/cloned object is not in this WeakSet and is rejected.
 */
const GENUINE = new WeakSet<object>();

/** True only for a payload actually produced by {@link minimize} (not a clone/spread/cast). */
export function isMinimizedPayload(value: unknown): value is MinimizedPayload {
  return typeof value === 'object' && value !== null && GENUINE.has(value);
}

/** Where an attachment's content came from. `repo_derived` is gated by policy. */
export interface MinimizedAttachment {
  content: string;
  provenance: 'host-authored' | 'user-pasted';
  repo_derived: boolean;
}

/** What a caller asks to minimize for an untrusted lane. */
export interface MinimizedRequest {
  instruction: string;
  attachments?: MinimizedAttachment[];
  category: TaskCategory;
  /** Repo classification + sensitivity for the deny-by-default gate (default unknown ⇒ sensitive). */
  repo_class?: RepoClass;
  sensitivity?: Sensitivity;
}

/** The validated, scrubbed, secret-free payload an untrusted lane may receive. */
export interface MinimizedPayload {
  readonly instruction: string;
  readonly attachments: readonly MinimizedAttachment[];
  readonly category: TaskCategory;
  readonly [BRAND]: true;
}

/** Result of minimization: either a payload or a block with a reason. */
export type MinimizeResult = { ok: true; payload: MinimizedPayload } | { ok: false; reason: string };

/** Outcome of a secret scan. `available: false` means the scanner (gitleaks) is absent. */
export interface SecretScanResult {
  available: boolean;
  hasSecret: boolean;
}

/** Scans candidate texts for secrets. Injected so core stays I/O-free. */
export type SecretScanner = (texts: readonly string[]) => Promise<SecretScanResult>;

/** Size limits — oversized inputs are blocked rather than truncated. */
export const LIMITS = {
  maxInstructionChars: 8_000,
  maxAttachmentChars: 8_000,
  maxAttachments: 8,
  maxTotalChars: 24_000,
} as const;

function blocked(reason: string): MinimizeResult {
  return { ok: false, reason };
}

/**
 * Best-effort redaction of repo-identifying strings (absolute paths, remotes/URLs,
 * emails). NOT the enforced no-leak boundary (see module docstring) — it handles
 * common no-space cases; paths containing spaces are a known best-effort gap.
 */
export function scrubText(text: string): string {
  return text
    // Repo remotes / URLs (incl. scp-style git@host:owner/repo) — before emails.
    .replace(/\b(?:git@|ssh:\/\/|https?:\/\/)[^\s'"`)]+/gi, '[url]')
    // Windows UNC/network paths (\\server\share\...) and drive paths (C:\...).
    .replace(/\\\\[^\s'"`)]+/g, '[path]')
    .replace(/\b[A-Za-z]:\\[^\s'"`)]+/g, '[path]')
    // Any absolute Unix path (incl. one-segment roots like /workspace or /repo),
    // anchored so it does not eat relative paths or prose like "and/or" — the
    // leading "/" must not follow a word char.
    .replace(/(?<![A-Za-z0-9_])(?:\/[A-Za-z0-9_.@~-]+)+/g, '[path]')
    // Bare emails.
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]');
}

function validateAttachment(a: unknown, i: number): MinimizedAttachment | MinimizeResult {
  if (typeof a !== 'object' || a === null) return blocked(`attachment[${i}] must be an object`);
  const rec = a as Record<string, unknown>;
  if (typeof rec.content !== 'string') return blocked(`attachment[${i}].content must be a string`);
  if (rec.provenance !== 'host-authored' && rec.provenance !== 'user-pasted') {
    return blocked(`attachment[${i}].provenance must be 'host-authored' or 'user-pasted'`);
  }
  if (typeof rec.repo_derived !== 'boolean') {
    return blocked(`attachment[${i}].repo_derived must be a boolean`);
  }
  return { content: rec.content, provenance: rec.provenance, repo_derived: rec.repo_derived };
}

/**
 * Minimize a request for an untrusted lane. Returns a branded payload or a block.
 * The injected `scanSecrets` is run on the scrubbed text; if the scanner is
 * unavailable (gitleaks not installed) the request is blocked — we never send
 * unscrubbed content to an untrusted lane (required-if-present).
 */
export async function minimize(
  request: MinimizedRequest,
  scanSecrets: SecretScanner,
): Promise<MinimizeResult> {
  // --- validation + limits ---
  if (typeof request.instruction !== 'string' || request.instruction.trim() === '') {
    return blocked('instruction must be a non-empty string');
  }
  if (!TASK_CATEGORIES.includes(request.category)) {
    return blocked(`category must be one of: ${TASK_CATEGORIES.join(', ')}`);
  }
  if (request.instruction.length > LIMITS.maxInstructionChars) {
    return blocked(`instruction exceeds ${LIMITS.maxInstructionChars} chars`);
  }

  // Deny-by-default at the REQUEST level: a worker may only receive content from a
  // clearly-safe context. The instruction itself can carry repo material, so we
  // gate the WHOLE request — not just repo-derived attachments — closing the
  // "private code placed in the instruction" bypass. (Minimizing private/sensitive
  // work for workers is a deferred capability; v0 blocks it entirely.)
  const repoClass: RepoClass = request.repo_class ?? 'unknown';
  const sensitivity: Sensitivity = request.sensitivity ?? 'unknown';
  if (!(repoClass === 'public' && sensitivity === 'normal')) {
    return blocked(
      `context not safe for an untrusted lane (repo_class=${repoClass}, sensitivity=${sensitivity}); ` +
        'minimization to a worker requires public + normal',
    );
  }

  const rawAttachments = request.attachments ?? [];
  if (!Array.isArray(rawAttachments)) return blocked('attachments must be an array');
  if (rawAttachments.length > LIMITS.maxAttachments) {
    return blocked(`too many attachments (max ${LIMITS.maxAttachments})`);
  }

  const attachments: MinimizedAttachment[] = [];
  for (let i = 0; i < rawAttachments.length; i++) {
    const v = validateAttachment(rawAttachments[i], i);
    if ('ok' in v) return v; // a MinimizeResult (block)
    if (v.content.length > LIMITS.maxAttachmentChars) {
      return blocked(`attachment[${i}] exceeds ${LIMITS.maxAttachmentChars} chars`);
    }
    attachments.push(v);
  }

  // --- scrub ---
  const instruction = scrubText(request.instruction);
  const scrubbedAttachments = attachments.map((a) => ({ ...a, content: scrubText(a.content) }));

  const total = instruction.length + scrubbedAttachments.reduce((n, a) => n + a.content.length, 0);
  if (total > LIMITS.maxTotalChars) {
    return blocked(`total payload exceeds ${LIMITS.maxTotalChars} chars`);
  }

  // --- secret scan (injected; unavailable OR throwing ⇒ block, fail-closed) ---
  let scan: SecretScanResult;
  try {
    scan = await scanSecrets([instruction, ...scrubbedAttachments.map((a) => a.content)]);
  } catch {
    return blocked('secret scan failed — blocked from untrusted lane');
  }
  if (!scan.available) {
    return blocked('secret scanner (gitleaks) unavailable — untrusted lane disabled');
  }
  if (scan.hasSecret) {
    return blocked('secret detected in payload — blocked from untrusted lane');
  }

  // --- brand + freeze ---
  const payload: MinimizedPayload = Object.freeze({
    instruction,
    attachments: Object.freeze(scrubbedAttachments.map((a) => Object.freeze(a))),
    category: request.category,
    [BRAND]: true as const,
  });
  GENUINE.add(payload); // register as the real boundary (survives the copyable type brand)
  return { ok: true, payload };
}
