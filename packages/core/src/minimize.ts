/**
 * The minimizer (C-3): the heart of the no-leak guarantee. Pure — no I/O. The
 * secret scanner is INJECTED (the gitleaks subprocess lives in the Node adapter)
 * so this module never imports `node:*` and stays fully testable.
 *
 * Two boundaries live here, each a nominal branded payload (module-private brand
 * symbol, no exported constructor, runtime WeakSet, and a guard test banning
 * `as <Payload>` casts elsewhere — so the boundary is enforceable by type, not
 * convention). The two payloads use DISTINCT brands and are never interchangeable:
 *  - {@link minimize} → {@link MinimizedPayload}: for a `worker` lane. The classic
 *    no-leak path — repo-derived content is blocked unless the context is
 *    explicitly public+normal.
 *  - {@link minimizeForReader} → {@link ReaderPayload}: for a `reader` lane (F-2).
 *    DELIBERATELY permits repo-read (private) code — that is the egress the reader
 *    tier authorizes — so it is NOT the no-leak guarantee. It keeps every other
 *    control: a hard context floor (public/private + normal; unknown rejected),
 *    the secret scan as a fail-closed gate scanned on RAW and scrubbed text, size
 *    bounds, branding, and `reader-derived` taint.
 *
 * Pipeline (shared helpers): validate + enforce limits → context gate → scrub repo
 * identifiers/paths/urls/emails → secret-scan (injected; unavailable/throw ⇒ block)
 * → brand + deep-freeze.
 *
 * What is ENFORCED vs best-effort (be honest):
 *  - ENFORCED: (1) the context gate (worker: public+normal only; reader: known
 *    repo + normal, unknown blocked); (2) the secret scan blocks on a hit OR when
 *    unavailable; (3) the payload is a bounded, typed, branded shape. For the
 *    reader path, secret egress is fail-closed + scanner-gated — NOT proven
 *    impossible (gitleaks catches many credentials, not all sensitive data; and
 *    the vendor's terms govern code once it is in the prompt).
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
 * Module-private brand for a {@link ReaderPayload} (F-2). DISTINCT from {@link BRAND}
 * so a worker payload and a reader payload are never interchangeable: a worker
 * executor must reject a reader payload and vice versa.
 */
const READER_BRAND: unique symbol = Symbol('ReaderPayload');

/**
 * Runtime registry of genuine payloads — the REAL boundary. The type brand alone
 * is copyable by object spread (`{ ...payload, instruction: rawRepoText }`), so
 * the untrusted executor (C-4) must verify {@link isMinimizedPayload} at runtime:
 * a spread/cloned object is not in this WeakSet and is rejected.
 */
const GENUINE = new WeakSet<object>();

/** SEPARATE registry of genuine reader payloads (see {@link READER_BRAND}). */
const READER_GENUINE = new WeakSet<object>();

/** True only for a payload actually produced by {@link minimize} (not a clone/spread/cast). */
export function isMinimizedPayload(value: unknown): value is MinimizedPayload {
  return typeof value === 'object' && value !== null && GENUINE.has(value);
}

/** True only for a payload actually produced by {@link minimizeForReader} (not a clone/spread/cast). */
export function isReaderPayload(value: unknown): value is ReaderPayload {
  return typeof value === 'object' && value !== null && READER_GENUINE.has(value);
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

/**
 * The validated, secret-free, bounded payload a `reader` lane may receive (F-2).
 * Unlike {@link MinimizedPayload} it MAY carry repo-derived (private) code — that
 * is the deliberate egress the reader tier authorizes — so it is a distinct type
 * with its own brand. Secret egress is still fail-closed + scanner-gated; the
 * payload is bounded; the lane gets this text, never a repo handle, tools, or shell.
 * Tainted `reader-derived`: never feed it to a worker or any further non-full egress.
 */
export interface ReaderPayload {
  readonly instruction: string;
  readonly attachments: readonly MinimizedAttachment[];
  readonly category: TaskCategory;
  /** Provenance taint: this payload's content may include private repo code. */
  readonly origin: 'reader-derived';
  readonly [READER_BRAND]: true;
}

/** Result of minimization: either a payload or a block with a reason. */
export type MinimizeResult = { ok: true; payload: MinimizedPayload } | { ok: false; reason: string };

/** Result of reader-minimization: either a reader payload or a block with a reason. */
export type ReaderMinimizeResult = { ok: true; payload: ReaderPayload } | { ok: false; reason: string };

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
  // Per-file attach cap raised from 8 KB so real source files (most exceed 8 KB)
  // can be attached VERBATIM for the worker-visibility / anti-hallucination lever,
  // instead of being dropped and re-paraphrased (which reintroduces the very
  // hallucination risk attaching was meant to kill).
  maxAttachmentChars: 64_000,
  maxAttachments: 24,
  // Total egress bound across instruction + attachments. Sits BELOW 3×attachment
  // (197 KB) so the oversized-total guard still trips on pathological payloads,
  // yet comfortably above one max-size file + instruction so the bigger per-file
  // cap is actually usable (not dead on arrival under the old 24 KB total).
  maxTotalChars: 192_000,
} as const;

/** A block outcome — the shared `ok: false` arm of both result types. */
type BlockResult = { ok: false; reason: string };

function blocked(reason: string): BlockResult {
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

function validateAttachment(a: unknown, i: number): MinimizedAttachment | BlockResult {
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

// --- shared private pipeline helpers (used by BOTH minimize + minimizeForReader) ---

/** Validate instruction non-empty + category + instruction length. Returns the instruction or a block. */
function validateInstruction(request: MinimizedRequest): string | BlockResult {
  if (typeof request.instruction !== 'string' || request.instruction.trim() === '') {
    return blocked('instruction must be a non-empty string');
  }
  if (!TASK_CATEGORIES.includes(request.category)) {
    return blocked(`category must be one of: ${TASK_CATEGORIES.join(', ')}`);
  }
  if (request.instruction.length > LIMITS.maxInstructionChars) {
    return blocked(`instruction exceeds ${LIMITS.maxInstructionChars} chars`);
  }
  return request.instruction;
}

/** Validate the attachments array, each attachment, and per-attachment length. */
function collectAttachments(request: MinimizedRequest): MinimizedAttachment[] | BlockResult {
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
  return attachments;
}

/** Enforce the total-size bound across instruction + attachments. */
function enforceTotal(instruction: string, attachments: readonly MinimizedAttachment[]): BlockResult | null {
  const total = instruction.length + attachments.reduce((n, a) => n + a.content.length, 0);
  if (total > LIMITS.maxTotalChars) return blocked(`total payload exceeds ${LIMITS.maxTotalChars} chars`);
  return null;
}

/**
 * Fail-closed secret gate: a scanner throw, unavailability, or hit ⇒ block.
 * `texts` are scanned verbatim (callers decide whether to scan raw, final, or both).
 */
async function secretGate(
  texts: readonly string[],
  scanSecrets: SecretScanner,
  lane: string,
): Promise<BlockResult | null> {
  let scan: SecretScanResult;
  try {
    scan = await scanSecrets(texts);
  } catch {
    return blocked(`secret scan failed — blocked from ${lane} lane`);
  }
  if (!scan.available) return blocked(`secret scanner (gitleaks) unavailable — ${lane} lane disabled`);
  if (scan.hasSecret) return blocked(`secret detected in payload — blocked from ${lane} lane`);
  return null;
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
  const ins = validateInstruction(request);
  if (typeof ins !== 'string') return ins;

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

  const collected = collectAttachments(request);
  if ('ok' in collected) return collected;

  // --- scrub ---
  const instruction = scrubText(request.instruction);
  const scrubbedAttachments = collected.map((a) => ({ ...a, content: scrubText(a.content) }));

  const overLimit = enforceTotal(instruction, scrubbedAttachments);
  if (overLimit) return overLimit;

  // --- secret scan (scrubbed text; unavailable OR throwing ⇒ block, fail-closed) ---
  const secret = await secretGate(
    [instruction, ...scrubbedAttachments.map((a) => a.content)],
    scanSecrets,
    'untrusted',
  );
  if (secret) return secret;

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

/**
 * Minimize a request for a `reader` lane (F-2). Like {@link minimize} but it
 * DELIBERATELY permits repo-derived (private) code — that is the egress the reader
 * tier authorizes — while keeping every other control:
 *  - context gate RELAXED to allow `repo_class` public OR private, but still
 *    REQUIRES `sensitivity: normal` and BLOCKS `repo_class: unknown` (fail-closed;
 *    a hard floor the policy gate also re-enforces);
 *  - secret egress stays fail-closed + scanner-gated — and is scanned on BOTH the
 *    raw and the scrubbed text, so scrubbing can't mask a secret-like token/URL;
 *  - same size bounds; output is a bounded, branded {@link ReaderPayload}, never a
 *    repo handle, tools, or shell; tainted `reader-derived`.
 *
 * NOT the old "no-leak" guarantee — secret egress is fail-closed + scanner-gated,
 * not proven impossible (gitleaks catches many credentials, not all sensitive
 * data). The vendor's terms govern code once it is in the prompt.
 *
 * KNOWN GAP (deferred): blocking `.env`/key/cert/token files by PATH requires
 * attachment path metadata the payload doesn't yet carry; the secret scan covers
 * such files' *contents* (a credential file with secrets ⇒ hit ⇒ block).
 */
export async function minimizeForReader(
  request: MinimizedRequest,
  scanSecrets: SecretScanner,
  opts?: { fullAccess?: boolean },
): Promise<ReaderMinimizeResult> {
  const fullAccess = opts?.fullAccess ?? false;

  // Validate instruction (skip length bound if fullAccess is true)
  if (typeof request.instruction !== 'string' || request.instruction.trim() === '') {
    return blocked('instruction must be a non-empty string');
  }
  if (!TASK_CATEGORIES.includes(request.category)) {
    return blocked(`category must be one of: ${TASK_CATEGORIES.join(', ')}`);
  }
  if (!fullAccess && request.instruction.length > LIMITS.maxInstructionChars) {
    return blocked(`instruction exceeds ${LIMITS.maxInstructionChars} chars`);
  }

  // Reader context gate: only if NOT fullAccess
  if (!fullAccess) {
    const repoClass: RepoClass = request.repo_class ?? 'unknown';
    const sensitivity: Sensitivity = request.sensitivity ?? 'unknown';
    if (!((repoClass === 'public' || repoClass === 'private') && sensitivity === 'normal')) {
      return blocked(
        `context not safe for a reader lane (repo_class=${repoClass}, sensitivity=${sensitivity}); ` +
          'a reader requires a known (public/private) repo + normal sensitivity',
      );
    }
  }

  // Collect attachments
  const rawAttachments = request.attachments ?? [];
  if (!Array.isArray(rawAttachments)) return blocked('attachments must be an array');
  if (!fullAccess && rawAttachments.length > LIMITS.maxAttachments) {
    return blocked(`too many attachments (max ${LIMITS.maxAttachments})`);
  }

  const collected: MinimizedAttachment[] = [];
  for (let i = 0; i < rawAttachments.length; i++) {
    const v = validateAttachment(rawAttachments[i], i);
    if ('ok' in v) return v;
    if (!fullAccess && v.content.length > LIMITS.maxAttachmentChars) {
      return blocked(`attachment[${i}] exceeds ${LIMITS.maxAttachmentChars} chars`);
    }
    collected.push(v);
  }

  // Scrub and verify total
  const instruction = fullAccess ? request.instruction : scrubText(request.instruction);
  const processedAttachments = fullAccess
    ? collected
    : collected.map((a) => ({ ...a, content: scrubText(a.content) }));

  if (!fullAccess) {
    const overLimit = enforceTotal(instruction, processedAttachments);
    if (overLimit) return overLimit;
  }

  // Secret scan on raw/scrubbed texts, fail-closed
  const scanTexts = fullAccess
    ? [request.instruction, ...collected.map((a) => a.content)]
    : [
        request.instruction,
        ...collected.map((a) => a.content),
        instruction,
        ...processedAttachments.map((a) => a.content),
      ];

  const secret = await secretGate(scanTexts, scanSecrets, 'reader');
  if (secret) return secret;

  // --- brand + freeze (distinct reader brand + registry; tainted reader-derived) ---
  const payload: ReaderPayload = Object.freeze({
    instruction,
    attachments: Object.freeze(processedAttachments.map((a) => Object.freeze(a))),
    category: request.category,
    origin: 'reader-derived' as const,
    [READER_BRAND]: true as const,
  });
  READER_GENUINE.add(payload);
  return { ok: true, payload };
}
