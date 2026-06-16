/**
 * Node-specific adapters for the routing brain.
 *
 * Exposed as the `@tokenmaxed/core/node` subpath. File I/O lives here, not in
 * the host-agnostic core barrel, so consumers that only need the pure routing
 * APIs never pull in `node:fs`.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LaneConfigError, LaneRegistry, parseLaneConfig } from './registry.ts';
import { PriceError, validatePriceTable } from './price.ts';
import type { PriceTable } from './price.ts';
import { PolicyConfigError, parsePolicyConfig } from './policy.ts';
import { isMinimizedPayload, isReaderPayload } from './minimize.ts';
import type { SecretScanner } from './minimize.ts';
import { READER_SYSTEM_FRAMING, RECOVERY_MAX_COMPLETION_TOKENS, WORKER_SYSTEM_FRAMING, buildReaderRequestBody, buildUntrustedRequestBody } from './boundary.ts';
import type { SafeReaderEnvelope, SafeUntrustedEnvelope, UntrustedLaneDTO } from './boundary.ts';
import { estimateTokens } from './usage.ts';
import type { RawUsage } from './usage.ts';
import { runTask } from './run.ts';
import type { RunDeps, RunRequest, RunResult, TrustedExecResult } from './run.ts';
import type { Lane, Policy, RouteContext } from './types.ts';
import { classifyHttpStatus, isTransient, LaneFailure } from './failure.ts';
import type { FailureKind } from './failure.ts';
import {
  LedgerError,
  SCHEMA_VERSION,
  parseEvent,
  serializeEvent,
  validateEventInput,
  validateOutcomeInput,
} from './ledger.ts';
import type {
  LedgerEvent,
  OutcomeEvent,
  OutcomeEventInput,
  TaskEvent,
  TaskEventInput,
} from './ledger.ts';

/**
 * Read, parse, and validate lane configuration from a file path or `file:` URL.
 * Throws {@link LaneConfigError} (with a clear message) on a read or parse failure.
 */
export function loadLaneConfig(path: string | URL): LaneRegistry {
  const filePath = typeof path === 'string' ? path : fileURLToPath(path);
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new LaneConfigError(`Could not read lane config at "${filePath}": ${detail}`);
  }
  return parseLaneConfig(text);
}

/**
 * Read, parse, and validate a price table (JSON) from a file path or `file:` URL.
 * Throws {@link PriceError} (with a clear message) on a read or parse failure.
 */
export function loadPriceTable(path: string | URL): PriceTable {
  const filePath = typeof path === 'string' ? path : fileURLToPath(path);
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PriceError(`Could not read price table at "${filePath}": ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PriceError(`Could not parse price table at "${filePath}" as JSON: ${detail}`);
  }
  return validatePriceTable(parsed);
}

/**
 * Read, parse, and validate policy configuration from a YAML file path or
 * `file:` URL. Throws {@link PolicyConfigError} on a read or parse failure.
 */
export function loadPolicyConfig(path: string | URL): Policy {
  const filePath = typeof path === 'string' ? path : fileURLToPath(path);
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PolicyConfigError(`Could not read policy config at "${filePath}": ${detail}`);
  }
  return parsePolicyConfig(text);
}

/**
 * A {@link SecretScanner} backed by the local `gitleaks` binary (stdin/temp-file
 * scan). **Required-if-present:** if gitleaks is not installed, the scanner
 * reports `available: false`, which makes the minimizer block — we never send
 * unscrubbed content to an untrusted lane.
 *
 * NOTE: the exact gitleaks CLI contract (flags / exit codes) is confirmed in the
 * adapter spike; the fail-safe paths (missing binary, unexpected error ⇒ treat as
 * unsafe) hold regardless.
 */
export function makeGitleaksScanner(): SecretScanner {
  return async (texts) => {
    let dir: string | undefined;
    try {
      dir = mkdtempSync(join(tmpdir(), 'tmx-scan-'));
      // Each text in its own file so multi-line secrets don't span boundaries.
      texts.forEach((t, i) => writeFileSync(join(dir as string, `p${i}.txt`), t, 'utf8'));
      const res = spawnSync('gitleaks', ['detect', '--no-git', '--source', dir, '--redact'], {
        encoding: 'utf8',
      });
      if (res.error) {
        const code = (res.error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { available: false, hasSecret: false }; // not installed
        return { available: true, hasSecret: true }; // unexpected error ⇒ fail safe (assume secret)
      }
      if (res.status === 0) return { available: true, hasSecret: false }; // no leaks
      return { available: true, hasSecret: true }; // status 1 (leaks) or anything else ⇒ fail safe
    } catch {
      // Temp-file / environment failure (e.g. unwritable tmp, quota) ⇒ never escape;
      // treat as unsafe so the minimizer blocks the untrusted send.
      return { available: true, hasSecret: true };
    } finally {
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  };
}

/** A minimal fetch-like response (so the transport can be injected in tests). */
interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  /** Optional text body accessor (unused today; present so richer mocks compile). */
  text?: () => Promise<string>;
}
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<FetchLikeResponse>;

/**
 * Wrap an async operation with a hard timeout + cooperative AbortSignal. When the
 * timer fires it:
 *   1. Calls `controller.abort()` so a well-behaved fetch can cancel early.
 *   2. Rejects the returned Promise with `LaneFailure('timeout')`.
 * When the operation finishes first the timer is cleared. Synchronous throws from
 * `fn` are caught via `Promise.resolve().then(fn)` so they never leak the timer.
 *
 * This is the ONLY real backstop for a stalled fetch: `Promise.race` alone cannot
 * interrupt a pending network call — an AbortSignal must be passed to `fetch` for
 * cooperative cancellation, and the wrapper timer provides the hard deadline.
 */
function wrapWithFetchTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const done = (cb: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cb();
    };
    // Arrow function keeps correct `this`; fires abort + rejection in one place.
    const timer = setTimeout(() => {
      controller.abort();
      done(() => reject(new LaneFailure('timeout')));
    }, timeoutMs);
    // Wrap in Promise.resolve().then() so synchronous throws become rejections.
    Promise.resolve()
      .then(() => fn(controller.signal))
      .then(
        (v) => done(() => resolve(v)),
        (e: unknown) =>
          done(() => {
            if (e && typeof e === 'object' && 'name' in e && (e as { name: unknown }).name === 'AbortError') {
              reject(new LaneFailure('timeout'));
            } else {
              reject(e);
            }
          }),
      );
  });
}

/** Injectable dependencies for {@link executeUntrusted} (transport + auth resolver). */
export interface UntrustedExecDeps {
  fetchImpl?: FetchLike;
  /** Resolve the opaque authHandle to a bearer token (e.g. from a keychain). */
  resolveAuth?: (authHandle: string) => string;
}

/** Result of an untrusted execution. Errors are content-free (redacted) by design. */
export interface UntrustedExecResult {
  ok: boolean;
  resultText?: string;
  reported?: RawUsage;
  /** true ⇒ `reported` includes ESTIMATED parts (recovery retry; log estimated, not exact). */
  reportedEstimated?: boolean;
  error?: string;
  failureKind?: FailureKind;
}

function extractText(data: unknown): string {
  const choices = (data as { choices?: { message?: { content?: unknown } }[] })?.choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

function extractUsage(data: unknown): RawUsage | undefined {
  const u = (data as { usage?: Record<string, unknown> })?.usage;
  if (!u) return undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  return { tokens_in: num(u.prompt_tokens), tokens_out: num(u.completion_tokens) };
}

function extractFinishReason(data: unknown): string | undefined {
  const c = (data as { choices?: { finish_reason?: unknown }[] })?.choices;
  const fr = c?.[0]?.finish_reason;
  return typeof fr === 'string' ? fr : undefined;
}

/**
 * A COMPLETE best-effort usage total across the two recovery calls. Use each call's
 * provider-reported usage where present; for a call that OMITTED `usage` (some
 * OpenAI-compatible proxies do), estimate that call's tokens from its prompt+result
 * text. This loses neither the first call's billed hidden-reasoning spend (when it
 * reported, as the empty+`length` call typically does) nor the other call's work, and
 * never records only one call as if it were the exact total. Each call re-sends the
 * full prompt, so an omitted call's input ≈ the prompt estimate.
 */
function combineRecoveryUsage(
  first: RawUsage | undefined,
  firstResultText: string,
  retry: RawUsage | undefined,
  retryResultText: string,
  promptText: string,
): { usage: RawUsage; estimated: boolean } {
  // Complete ONE call's usage field-by-field: keep each provider-reported side, ESTIMATE
  // any MISSING side from text (a request re-sends the full prompt ⇒ input ≈ prompt est).
  // RawUsage is PARTIAL by type, so check tokens_in AND tokens_out per call — a provider
  // that reports only one side must NOT be treated as a complete, exact total.
  const completeOne = (u: RawUsage | undefined, resultText: string): { usage: RawUsage; estimated: boolean } => {
    const hasIn = typeof u?.tokens_in === 'number';
    const hasOut = typeof u?.tokens_out === 'number';
    const usage: RawUsage = {
      tokens_in: hasIn ? (u!.tokens_in as number) : estimateTokens(promptText),
      tokens_out: hasOut ? (u!.tokens_out as number) : estimateTokens(resultText),
      ...(u?.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}),
      ...(u?.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: u.cache_creation_input_tokens } : {}),
    };
    return { usage, estimated: !hasIn || !hasOut };
  };
  const a = completeOne(first, firstResultText);
  const b = completeOne(retry, retryResultText);
  // `estimated` ⇒ at least one field of either call had to be text-estimated, so the
  // total is NOT provider-exact and must be logged `tokens_estimated: true`.
  return { usage: addUsage(a.usage, b.usage) as RawUsage, estimated: a.estimated || b.estimated };
}

/**
 * Failure kind for a BEST-EFFORT recovery-retry that came back non-OK. Keep a
 * genuine TRANSIENT capacity signal (rate_limited / quota_exhausted / timeout) so
 * `shouldCooldown` still cools the exhausted lane down — but remap a PERMANENT
 * classification (e.g. a 400 rejecting OUR injected `max_tokens`) to a transient
 * `provider_error` so an optional recovery attempt can never poison routing into a
 * non-fallback `bad_request`.
 */
function recoveryRetryFailureKind(status: number): FailureKind {
  const kind = classifyHttpStatus(status);
  return isTransient(kind) ? kind : 'provider_error';
}

/**
 * Sum two RawUsage records so a retry's spend ADDS to (never replaces) the first
 * call's. Mirrors {@link extractUsage}'s shape — tokens_in/tokens_out always
 * present (possibly undefined), optional cache fields included ONLY when a side
 * reported them — so a summed result deep-equals a single-call result.
 */
function addUsage(a: RawUsage | undefined, b: RawUsage | undefined): RawUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const out: RawUsage = { tokens_in: sum(a.tokens_in, b.tokens_in), tokens_out: sum(a.tokens_out, b.tokens_out) };
  const cacheRead = sum(a.cache_read_input_tokens, b.cache_read_input_tokens);
  if (cacheRead !== undefined) out.cache_read_input_tokens = cacheRead;
  const cacheCreate = sum(a.cache_creation_input_tokens, b.cache_creation_input_tokens);
  if (cacheCreate !== undefined) out.cache_creation_input_tokens = cacheCreate;
  return out;
}

/**
 * Execute a task on an untrusted lane over HTTP. The ONLY untrusted-execution
 * entry point; it accepts a {@link SafeUntrustedEnvelope} and additionally
 * verifies at runtime that the payload is genuine (produced by `minimize`) — a
 * spread/cloned object is refused, never sent. On any failure it returns a
 * content-free error (never throws raw content).
 */
export async function executeUntrusted(
  env: SafeUntrustedEnvelope,
  deps: UntrustedExecDeps = {},
): Promise<UntrustedExecResult> {
  // Runtime boundary check — the real guarantee (the type brand is copyable).
  if (!isMinimizedPayload(env.payload)) {
    return { ok: false, error: 'refused: payload was not produced by minimize()' };
  }
  const doFetch = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!doFetch) return { ok: false, error: 'no fetch implementation available' };

  // Resolve auth FIRST and classify its failure as auth_failed (permanent) — a
  // missing/locked keychain entry must not be retried as a transient provider error.
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.lane.authHandle) {
    let token = '';
    try {
      token = deps.resolveAuth ? deps.resolveAuth(env.lane.authHandle) : '';
    } catch {
      return { ok: false, error: 'auth resolution failed for untrusted lane', failureKind: 'auth_failed' };
    }
    if (!token) return { ok: false, error: 'auth resolution failed for untrusted lane', failureKind: 'auth_failed' };
    headers.authorization = `Bearer ${token}`;
  }

  try {
    const body = JSON.stringify(buildUntrustedRequestBody(env));
    const res = await doFetch(env.lane.endpoint, { method: 'POST', headers, body });
    if (!res.ok) {
      return { ok: false, error: `untrusted lane returned status ${res.status}`, failureKind: classifyHttpStatus(res.status) };
    }
    const data = await res.json();
    let result = data;
    let text = extractText(result);
    let reported = extractUsage(result);
    let reportedEstimated = false;
    // One-shot retry: reasoning-heavy models (e.g. MiniMax-M3) can exhaust the
    // default cap on hidden reasoning and return empty content with
    // finish_reason: "length". Retry once with a larger CONSTANT max_tokens to
    // recover. (max_tokens is never sourced from caller content — see
    // boundary.ts allowlist.) The first call ALREADY consumed tokens, so its
    // usage is ACCUMULATED with the retry's (and reported even if the retry fails).
    if (text === '' && extractFinishReason(result) === 'length') {
      try {
        const body2 = JSON.stringify(buildUntrustedRequestBody(env, true));
        // Bound the retry with the same fetch timeout + AbortSignal the trusted/Ollama
        // executors use, so a recovery retry can never hang indefinitely and block
        // fallback (the first call returned promptly; the retry must too or fail fast).
        const retry = await wrapWithFetchTimeout(async (signal) => {
          const res2 = await doFetch(env.lane.endpoint, { method: 'POST', headers, body: body2, signal });
          if (!res2.ok) return { ok: false as const, status: res2.status, data: undefined };
          return { ok: true as const, status: res2.status, data: await res2.json() };
        }, DEFAULT_FETCH_TIMEOUT_MS);
        if (!retry.ok) {
          // Best-effort recovery non-OK: keep a real capacity signal (so the lane cools
          // down) but remap a permanent 400 (model rejecting our injected max_tokens) to
          // transient so it never blocks fallback; carry the first call's usage.
          return { ok: false, error: `untrusted lane recovery retry returned status ${retry.status}`, failureKind: recoveryRetryFailureKind(retry.status), ...(reported ? { reported } : {}) };
        }
        // Worker requests prepend WORKER_SYSTEM_FRAMING (buildUntrustedRequestBody), so
        // the estimate's prompt MUST include it too or worker input tokens are
        // undercounted (mirrors the reader recovery path below).
        const promptText = [WORKER_SYSTEM_FRAMING, env.payload.instruction, ...env.payload.attachments.map((a) => a.content)].join('\n\n');
        result = retry.data;
        text = extractText(result);
        // Complete best-effort total: each call's reported usage where present, a text
        // estimate where a call omitted `usage` — so neither the first call's billed
        // (hidden-reasoning) spend nor the retry's output is ever lost. `estimated`
        // flags that the total is NOT provider-exact (logged tokens_estimated:true).
        const combined = combineRecoveryUsage(reported, '', extractUsage(result), text, promptText);
        reported = combined.usage;
        reportedEstimated = combined.estimated;
      } catch {
        // The retry itself threw (network / parse / timeout) AFTER the first call
        // already billed — preserve that spend so a metered failed attempt is never
        // under-recorded (content-free, like the outer catch).
        return { ok: false, error: 'untrusted lane request failed', failureKind: 'provider_error', ...(reported ? { reported } : {}) };
      }
    }
    return { ok: true, resultText: text, reported, ...(reportedEstimated ? { reportedEstimated: true } : {}) };
  } catch {
    // Content-free: never surface payload/repo text (or a resolver's raw error).
    return { ok: false, error: 'untrusted lane request failed', failureKind: 'provider_error' };
  }
}

/**
 * Execute a task on a READER lane over HTTP (F-2). Mirrors {@link executeUntrusted}
 * but accepts a {@link SafeReaderEnvelope} and verifies at runtime that the payload
 * is a genuine reader payload (produced by `minimizeForReader`) — a spread/clone or
 * a worker payload is refused, never sent. The request carries the answer-only
 * framing built by {@link buildReaderRequestBody}. On any failure it returns a
 * content-free error (never throws raw content).
 */
export async function executeReader(
  env: SafeReaderEnvelope,
  deps: UntrustedExecDeps = {},
): Promise<UntrustedExecResult> {
  // Runtime boundary check — the real guarantee (the type brand is copyable).
  if (!isReaderPayload(env.payload)) {
    return { ok: false, error: 'refused: payload was not produced by minimizeForReader()' };
  }
  const doFetch = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!doFetch) return { ok: false, error: 'no fetch implementation available' };

  // Resolve auth FIRST and classify its failure as auth_failed (permanent).
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.lane.authHandle) {
    let token = '';
    try {
      token = deps.resolveAuth ? deps.resolveAuth(env.lane.authHandle) : '';
    } catch {
      return { ok: false, error: 'auth resolution failed for reader lane', failureKind: 'auth_failed' };
    }
    if (!token) return { ok: false, error: 'auth resolution failed for reader lane', failureKind: 'auth_failed' };
    headers.authorization = `Bearer ${token}`;
  }

  try {
    const body = JSON.stringify(buildReaderRequestBody(env));
    const res = await doFetch(env.lane.endpoint, { method: 'POST', headers, body });
    if (!res.ok) {
      return { ok: false, error: `reader lane returned status ${res.status}`, failureKind: classifyHttpStatus(res.status) };
    }
    const data = await res.json();
    let result = data;
    let text = extractText(result);
    let reported = extractUsage(result);
    let reportedEstimated = false;
    // One-shot retry: reasoning-heavy models (e.g. MiniMax-M3) can exhaust the
    // default cap on hidden reasoning and return empty content with
    // finish_reason: "length". Retry once with a larger CONSTANT max_tokens to
    // recover. (max_tokens is never sourced from caller content — see
    // boundary.ts allowlist.) First-call usage is ACCUMULATED with the retry's
    // (and reported even if the retry fails) so metered spend is never under-recorded.
    if (text === '' && extractFinishReason(result) === 'length') {
      try {
        const body2 = JSON.stringify(buildReaderRequestBody(env, true));
        // Bound the retry with the same fetch timeout + AbortSignal the trusted/Ollama
        // executors use, so a recovery retry can never hang indefinitely and block
        // fallback (the first call returned promptly; the retry must too or fail fast).
        const retry = await wrapWithFetchTimeout(async (signal) => {
          const res2 = await doFetch(env.lane.endpoint, { method: 'POST', headers, body: body2, signal });
          if (!res2.ok) return { ok: false as const, status: res2.status, data: undefined };
          return { ok: true as const, status: res2.status, data: await res2.json() };
        }, DEFAULT_FETCH_TIMEOUT_MS);
        if (!retry.ok) {
          // Best-effort recovery non-OK: keep a real capacity signal (so the lane cools
          // down) but remap a permanent 400 (model rejecting our injected max_tokens) to
          // transient so it never blocks fallback; carry the first call's usage.
          return { ok: false, error: `reader lane recovery retry returned status ${retry.status}`, failureKind: recoveryRetryFailureKind(retry.status), ...(reported ? { reported } : {}) };
        }
        // Reader requests prepend READER_SYSTEM_FRAMING (buildReaderRequestBody), so the
        // estimate's prompt MUST include it too or reader input tokens are undercounted.
        const promptText = [READER_SYSTEM_FRAMING, env.payload.instruction, ...env.payload.attachments.map((a) => a.content)].join('\n\n');
        result = retry.data;
        text = extractText(result);
        // Complete best-effort total: each call's reported usage where present, a text
        // estimate where a call omitted `usage` — so neither the first call's billed
        // (hidden-reasoning) spend nor the retry's output is ever lost. `estimated` flags
        // that the total is NOT provider-exact (logged tokens_estimated:true).
        const combined = combineRecoveryUsage(reported, '', extractUsage(result), text, promptText);
        reported = combined.usage;
        reportedEstimated = combined.estimated;
      } catch {
        // The retry itself threw (network / parse / timeout) AFTER the first call
        // already billed — preserve that spend so a metered failed attempt is never
        // under-recorded (content-free, like the outer catch).
        return { ok: false, error: 'reader lane request failed', failureKind: 'provider_error', ...(reported ? { reported } : {}) };
      }
    }
    return { ok: true, resultText: text, reported, ...(reportedEstimated ? { reportedEstimated: true } : {}) };
  } catch {
    // Content-free: never surface payload/repo text (or a resolver's raw error).
    return { ok: false, error: 'reader lane request failed', failureKind: 'provider_error' };
  }
}

/** Default ledger location: `~/.tokenmaxed/ledger.jsonl`. */
export function defaultLedgerPath(): string {
  return join(homedir(), '.tokenmaxed', 'ledger.jsonl');
}

/** Per-model token usage `{ in, out }` read from host transcripts. */
export type CliUsageByModel = Record<string, { in: number; out: number }>;

/**
 * Read the HOST CLI's own per-model token usage from Claude Code's transcript
 * JSONL for THIS project, so the summary can fold native main-session usage into
 * the per-lane counts (e.g. the Opus you're talking to now). These are REAL
 * provider-reported numbers off disk — not estimates — so surfacing them never
 * violates the "never lie about unobservable usage" rule.
 *
 * Claude Code stores transcripts at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`,
 * where the cwd's every non-alphanumeric char is replaced by `-`. Assistant turns
 * carry `{ type:'assistant', message:{ model, usage:{ input_tokens, output_tokens,
 * cache_read_input_tokens?, cache_creation_input_tokens? } } }`.
 *
 * Best-effort and FAIL-OPEN: any error (missing dir, bad JSON, unreadable file)
 * yields `{}` — the summary must never break because a transcript couldn't be read.
 * A byte budget bounds the work on the SessionStart path.
 */
export function readCliUsageByModel(projectDir?: string): CliUsageByModel {
  const out: CliUsageByModel = Object.create(null);
  try {
    const dir = projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const encoded = dir.replace(/[^A-Za-z0-9]/g, '-');
    const tdir = join(homedir(), '.claude', 'projects', encoded);
    if (!existsSync(tdir)) return out;
    let budget = 64 * 1024 * 1024; // cap total bytes parsed (perf guard for SessionStart)
    for (const f of readdirSync(tdir)) {
      if (!f.endsWith('.jsonl')) continue;
      let text: string;
      try {
        text = readFileSync(join(tdir, f), 'utf8');
      } catch {
        continue;
      }
      budget -= Buffer.byteLength(text);
      for (const line of text.split('\n')) {
        if (!line) continue;
        let e: { type?: unknown; message?: { model?: unknown; usage?: Record<string, unknown> } };
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e?.type !== 'assistant') continue;
        const model = e.message?.model;
        const u = e.message?.usage;
        if (typeof model !== 'string' || !u) continue;
        const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
        const inc = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
        const outc = num(u.output_tokens);
        const g = out[model] ?? (out[model] = { in: 0, out: 0 });
        g.in += inc;
        g.out += outc;
      }
      if (budget <= 0) break;
    }
  } catch {
    /* best-effort: fail open with whatever we gathered */
  }
  return out;
}

/**
 * Append-only JSONL ledger on disk.
 *
 * Each call to {@link JsonlLedger.append} assigns a unique `id`, the next
 * monotonic `seq`, and an ISO timestamp, then writes one content-free line.
 * Single-process use is assumed for v0: one instance owns the file; concurrent
 * writers from separate processes are out of scope.
 */
export class JsonlLedger {
  readonly path: string;
  #events: LedgerEvent[] | null = null;
  /** Whether the on-disk file is empty or already ends with a newline. */
  #fileEndsWithNewline = true;

  constructor(path: string = defaultLedgerPath()) {
    this.path = path;
  }

  #load(): LedgerEvent[] {
    if (this.#events) return this.#events;
    if (!existsSync(this.path)) {
      this.#events = [];
      return this.#events;
    }
    const text = readFileSync(this.path, 'utf8');
    // If a pre-existing file's last record lacks a trailing newline, the next
    // append must insert one first or it would concatenate onto that line.
    this.#fileEndsWithNewline = text === '' || text.endsWith('\n');
    const events: LedgerEvent[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new LedgerError(`Ledger "${this.path}" has invalid JSON on line ${i + 1}: ${detail}`);
      }
      // Freeze cached events so a reference handed back cannot be mutated to
      // corrupt later summaries or seq assignment.
      events.push(Object.freeze(parseEvent(obj)));
    }
    this.#events = events;
    return events;
  }

  #nextSeq(events: readonly LedgerEvent[]): number {
    return events.reduce((max, e) => Math.max(max, e.seq), -1) + 1;
  }

  #write(event: LedgerEvent, events: LedgerEvent[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const prefix = this.#fileEndsWithNewline ? '' : '\n';
    appendFileSync(this.path, prefix + serializeEvent(event) + '\n', 'utf8');
    this.#fileEndsWithNewline = true;
    events.push(event);
  }

  /** All events currently in the ledger (a defensive copy). */
  readAll(): LedgerEvent[] {
    return [...this.#load()];
  }

  /** Append one task event; returns the persisted event with its id/seq/ts. */
  appendTask(input: TaskEventInput): TaskEvent {
    const events = this.#load();
    const event: TaskEvent = Object.freeze({
      event_type: 'task',
      schema_version: SCHEMA_VERSION,
      id: randomUUID(),
      seq: this.#nextSeq(events),
      ts: new Date().toISOString(),
      ...validateEventInput(input),
    });
    this.#write(event, events);
    return event;
  }

  /** Append one outcome (review) event; returns the persisted event. */
  appendOutcome(input: OutcomeEventInput): OutcomeEvent {
    const events = this.#load();
    const event: OutcomeEvent = Object.freeze({
      event_type: 'outcome',
      schema_version: SCHEMA_VERSION,
      id: randomUUID(),
      seq: this.#nextSeq(events),
      ts: new Date().toISOString(),
      ...validateOutcomeInput(input),
    });
    this.#write(event, events);
    return event;
  }
}

// ---- lane executors (C-9) + runTask wiring ------------------------------

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { input: string; encoding: 'utf8'; maxBuffer: number },
) => { status: number | null; stdout?: string; error?: Error; signal?: NodeJS.Signals | null };

/**
 * Generic CLI-lane executor (answer-only): spawn the lane's `command` with its
 * `args`, pass the instruction on stdin, return stdout as the result. Any
 * provider CLI (Codex, Gemini, Kimi Code, …) plugs in by config. Throws on
 * spawn/non-zero exit so runTask records a failed attempt and degrades.
 */
/** A trusted-lane executor: trusted lanes receive the full instruction + attachments. */
type TrustedExecFn = (lane: Lane, instruction: string, attachments?: readonly { content: string }[]) => Promise<TrustedExecResult>;

/** Combine the instruction with attachment contents into a single prompt (trusted lanes get full context). */
function combinedPrompt(instruction: string, attachments?: readonly { content: string }[]): string {
  return attachments && attachments.length > 0
    ? [instruction, ...attachments.map((a) => a.content)].join('\n\n')
    : instruction;
}

const numOrUndef = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/**
 * Conservative cap on a prompt passed via the `{prompt}` ARGV placeholder. The OS limits a
 * single argument / total argv (ARG_MAX — ~256 KB per arg on macOS, higher on Linux), and a
 * prompt approaching that is better sent to a stdin-based lane. 128 KB is comfortably under
 * every platform's limit and far larger than any bounded worker subtask.
 */
const MAX_PROMPT_ARG_BYTES = 128 * 1024;

export function makeCliExecutor(spawnImpl?: SpawnLike): TrustedExecFn {
  const spawn: SpawnLike =
    spawnImpl ?? ((cmd, args, opts) => spawnSync(cmd, [...args], opts) as ReturnType<SpawnLike>);
  return async (lane, instruction, attachments) => {
    if (!lane.command) throw new Error(`cli lane "${lane.id}" has no command configured`);
    const input = combinedPrompt(instruction, attachments);
    // Arg placeholder substitution:
    //   `{model}`  — a CLI lane can pass `--model {model}` instead of hard-pinning a
    //                version, so the spawn always uses the lane's CURRENT model. By the
    //                time a lane reaches the executor its `model` is already the concrete,
    //                price-table-resolved id (a `<family>@latest` alias has been resolved
    //                on the routing path), so CLI lanes stay self-updating with no stale
    //                literal.
    //   `{prompt}` — for a CLI that takes the prompt as an ARGV argument rather than on
    //                stdin (e.g. `grok -p {prompt}`). Most CLIs (codex exec, the agy
    //                companion's `--stdin`) read the instruction from stdin instead.
    const usesPromptArg = (lane.args ?? []).some((a) => a.includes('{prompt}'));
    // A `{prompt}` lane puts the whole prompt on the command line, which the OS caps
    // (ARG_MAX). Fail fast with a typed error (⇒ clean fallback / degrade) rather than a
    // cryptic E2BIG spawn failure when a delegated prompt is too large for argv.
    if (usesPromptArg && Buffer.byteLength(input, 'utf8') > MAX_PROMPT_ARG_BYTES) {
      throw new LaneFailure(
        'provider_error',
        `cli lane "${lane.id}" prompt is too large to pass as a command-line argument (> ${MAX_PROMPT_ARG_BYTES} bytes) — use a stdin-based CLI lane for large inputs`,
      );
    }
    const args = (lane.args ?? []).map((a) => a.replaceAll('{model}', lane.model).replaceAll('{prompt}', input));
    // Transport: an argv-prompt lane already carries the prompt in `args`, so do NOT also
    // pipe it on stdin — that would DUPLICATE it for any CLI that reads both, and shove a
    // large payload into a pipe the CLI never drains. stdin carries the prompt only for the
    // (default) lanes that read it there. NOTE: a `{prompt}` lane's prompt is visible in the
    // process argv (e.g. `ps`), inherent to argv-prompt CLIs like `grok -p` — prefer a
    // stdin lane when the prompt may be sensitive.
    const stdinInput = usesPromptArg ? '' : input;
    const res = spawn(lane.command, args, { input: stdinInput, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (res.error) {
      // Distinguish a TIMEOUT (the common "review took too long" case — spawnSync sets
      // ETIMEDOUT + a SIGTERM signal) from a real spawn failure, so the surfaced error
      // is actionable instead of a blanket "failed to spawn". All fields used here are
      // content-free: the failure CODE and the lane's own configured command — never
      // the prompt/diff (which the CLI receives on stdin and could echo to stderr).
      const code = (res.error as NodeJS.ErrnoException).code;
      // ENOBUFS (CLI output exceeded maxBuffer) ALSO kills the child with SIGTERM, so it
      // must be ruled out BEFORE the SIGTERM⇒timeout heuristic — otherwise oversized
      // output is mislabeled "timed out", hiding the real, actionable cause.
      if (code === 'ENOBUFS') throw new LaneFailure('provider_error', `cli lane "${lane.id}" produced too much output (exceeded the buffer limit)`);
      if (code === 'ETIMEDOUT' || res.signal === 'SIGTERM') throw new LaneFailure('timeout', `cli lane "${lane.id}" (command "${lane.command}") timed out`);
      if (code === 'ENOENT' || code === 'EACCES') throw new LaneFailure('provider_error', `cli lane "${lane.id}" failed to spawn: command "${lane.command}" ${code === 'ENOENT' ? 'not found' : 'not executable'} (check the lane's absolute command path / PATH)`);
      throw new LaneFailure('provider_error', `cli lane "${lane.id}" failed to spawn${code ? ` (${code})` : ''}`);
    }
    if (res.status !== 0) {
      // Content-free: a manager CLI receives the full prompt/diff on stdin and may echo
      // it to stderr, so we surface ONLY the exit status — never raw stderr (a leak path).
      throw new LaneFailure('provider_error', `cli lane "${lane.id}" exited with status ${res.status}`);
    }
    return { resultText: res.stdout ?? '' }; // CLIs rarely report tokens ⇒ estimated downstream
  };
}

type OllamaFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<FetchLikeResponse>;

/** Default per-fetch timeout for API/Ollama executors (avoids an indefinite hang on a stalled socket). */
const DEFAULT_FETCH_TIMEOUT_MS = 90_000;

/**
 * Local Ollama executor: POST /api/generate; uses reported eval counts when present.
 * A hard `fetchTimeoutMs` (default 90 s) bounds a stalled Ollama socket — the real
 * risk is a hung keep-alive or a model loading indefinitely. The AbortSignal is also
 * passed to the fetch so a well-behaved implementation cancels early.
 */
export function makeOllamaExecutor(fetchImpl?: OllamaFetch, opts?: { fetchTimeoutMs?: number }): TrustedExecFn {
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as OllamaFetch);
  const fetchTimeoutMs = opts?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  return async (lane, instruction, attachments) => {
    const base = lane.endpoint ?? 'http://localhost:11434';
    const body = JSON.stringify({ model: lane.model, prompt: combinedPrompt(instruction, attachments), stream: false });
    // Wrap fetch + json() together: a stalled response BODY (not just the initial
    // connection) can also hang indefinitely, so the AbortController stays active
    // through body parsing. res.ok is checked before res.json() so a non-OK
    // response with invalid JSON produces the right classifyHttpStatus failure.
    const { ok, status, data } = await wrapWithFetchTimeout(async (signal) => {
      const res = await doFetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      });
      if (!res.ok) return { ok: false as const, status: res.status, data: undefined };
      const data = (await res.json()) as { response?: unknown; prompt_eval_count?: unknown; eval_count?: unknown };
      return { ok: true as const, status: res.status, data };
    }, fetchTimeoutMs);
    if (!ok) throw new LaneFailure(classifyHttpStatus(status), `ollama lane "${lane.id}" returned status ${status}`);
    return {
      resultText: typeof data!.response === 'string' ? data!.response : '',
      reported: { tokens_in: numOrUndef(data!.prompt_eval_count), tokens_out: numOrUndef(data!.eval_count) },
    };
  };
}

/**
 * Trusted API executor (OpenAI-compatible): sends the FULL instruction +
 * attachments (no minimization — a `full`/trusted lane the user approved). Auth
 * is resolved from the lane's authHandle; a lane that needs auth without a
 * resolver fails closed (throws ⇒ runTask degrades).
 *
 * A hard `fetchTimeoutMs` (default 90 s) bounds a stalled API socket. A stalled
 * HTTP keep-alive or DNS hang produces a Promise that never rejects, which no
 * upstream `Promise.race` can preempt — the AbortController + timer in
 * `wrapWithFetchTimeout` is the only real backstop.
 */
export function makeTrustedApiExecutor(
  deps: { fetchImpl?: FetchLike; resolveAuth?: (authHandle: string) => string; fetchTimeoutMs?: number } = {},
): TrustedExecFn {
  const doFetch = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  return async (lane, instruction, attachments) => {
    if (!lane.endpoint) throw new LaneFailure('bad_request', `api lane "${lane.id}" has no endpoint configured`);
    if (!doFetch) throw new LaneFailure('provider_error', 'no fetch implementation available');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (lane.authHandle) {
      let token = '';
      try {
        token = deps.resolveAuth ? deps.resolveAuth(lane.authHandle) : '';
      } catch {
        throw new LaneFailure('auth_failed', `auth resolution failed for api lane "${lane.id}"`);
      }
      if (!token) throw new LaneFailure('auth_failed', `auth resolution failed for api lane "${lane.id}"`);
      headers.authorization = `Bearer ${token}`;
    }
    // First call carries NO max_tokens (so a lane whose model rejects it / needs a
    // different field / caps lower is never broken); the cap is added ONLY on the
    // empty+`length` recovery retry (a constant, never from caller content). Spend the
    // first call billed is captured in `billedUsage` (outer scope) so that even if the
    // wrapper REJECTS (timeout/abort) during the retry, the thrown failure still
    // reports it — a metered failed attempt is never under-recorded.
    let billedUsage: RawUsage | undefined;
    // Wrap fetch + json() together so the AbortController stays active through body
    // parsing. res.ok is checked before res.json() so a non-OK response with invalid
    // JSON produces the right classifyHttpStatus failure.
    const { ok, status, data, reported, reportedEstimated } = await wrapWithFetchTimeout(async (signal) => {
      const buildBody = (recovery = false) => JSON.stringify({
        model: lane.model,
        messages: [{ role: 'user', content: combinedPrompt(instruction, attachments) }],
        ...(recovery ? { max_tokens: RECOVERY_MAX_COMPLETION_TOKENS } : {}),
      });
      const res = await doFetch(lane.endpoint!, { method: 'POST', headers, body: buildBody(), signal });
      if (!res.ok) return { ok: false as const, status: res.status, data: undefined, reported: undefined, reportedEstimated: false };
      let data = (await res.json()) as { choices?: { message?: { content?: unknown } }[]; usage?: Record<string, unknown> };
      let reported = extractUsage(data);
      let reportedEstimated = false;
      billedUsage = reported;
      // One-shot retry: reasoning-heavy models (e.g. MiniMax-M3) can exhaust the
      // provider default on hidden reasoning and return empty content with
      // finish_reason: "length". Retry once WITH a constant max_tokens cap to
      // recover. The first call already consumed tokens, so ACCUMULATE its usage.
      if (extractText(data) === '' && extractFinishReason(data) === 'length') {
        const res2 = await doFetch(lane.endpoint!, { method: 'POST', headers, body: buildBody(true), signal });
        // The retry is BEST-EFFORT recovery. Keep a real capacity signal (so the lane
        // cools down) but remap a permanent 400 (model rejecting our injected max_tokens)
        // to transient so it never blocks fallback; carry the first call's billed usage.
        // Status is a number (content-free).
        if (!res2.ok) throw new LaneFailure(recoveryRetryFailureKind(res2.status), `api lane "${lane.id}" recovery retry returned status ${res2.status}`, reported);
        data = (await res2.json()) as { choices?: { message?: { content?: unknown } }[]; usage?: Record<string, unknown> };
        // Complete best-effort total: each call's reported usage where present, a text
        // estimate where a call omitted `usage` — so neither the first call's billed
        // reasoning nor the retry's output is lost. `estimated` flags a non-exact total.
        const combined = combineRecoveryUsage(reported, '', extractUsage(data), extractText(data), combinedPrompt(instruction, attachments));
        reported = combined.usage;
        reportedEstimated = combined.estimated;
        billedUsage = reported;
      }
      return { ok: true as const, status: res.status, data, reported, reportedEstimated };
    }, fetchTimeoutMs).catch((err: unknown) => {
      // ANY rejection AFTER the first call billed (wrap timeout/abort, a plain fetch
      // error, a json() throw, or the retry-failure above) must carry that spend so
      // runTask records real usage, not ZERO. Keep a typed failure's own kind (e.g. a
      // wrap 'timeout'); otherwise mark transient ('provider_error') so routing can
      // fall back. Skip if the error ALREADY carries usage. Message is content-free.
      const alreadyHasUsage = err instanceof LaneFailure && err.reported !== undefined;
      if (billedUsage && !alreadyHasUsage) {
        const kind: FailureKind = err instanceof LaneFailure ? err.failureKind : 'provider_error';
        throw new LaneFailure(kind, `api lane "${lane.id}" failed after billing the first call`, billedUsage);
      }
      throw err;
    });
    if (!ok) throw new LaneFailure(classifyHttpStatus(status), `api lane "${lane.id}" returned status ${status}`, reported);
    const content = data!.choices?.[0]?.message?.content;
    return {
      resultText: typeof content === 'string' ? content : '',
      reported,
      ...(reportedEstimated ? { reportedEstimated: true } : {}),
    };
  };
}

/**
 * Trusted-lane dispatcher: local ⇒ Ollama; cli with a command ⇒ generic CLI;
 * api with an endpoint ⇒ trusted API; anything else (no command/endpoint — the
 * host model) ⇒ native directive (the host does it). Sub-executors are injectable.
 */
export function makeTrustedExecutor(deps: { cli?: TrustedExecFn; ollama?: TrustedExecFn; api?: TrustedExecFn } = {}): TrustedExecFn {
  const cli = deps.cli ?? makeCliExecutor();
  const ollama = deps.ollama ?? makeOllamaExecutor();
  const api = deps.api ?? makeTrustedApiExecutor();
  return async (lane, instruction, attachments) => {
    if (lane.native) return { resultText: '', native: true }; // explicit host lane ⇒ host performs it
    if (lane.kind === 'local') return ollama(lane, instruction, attachments);
    if (lane.kind === 'cli' && lane.command) return cli(lane, instruction, attachments);
    if (lane.kind === 'api' && lane.endpoint) return api(lane, instruction, attachments);
    // A non-native lane with no executor config is MISCONFIGURED — throw so runTask
    // records a failed attempt and degrades, rather than silently running natively.
    throw new Error(`lane "${lane.id}" has no executor configured (set native: true, or command / endpoint)`);
  };
}

/** Build the narrow untrusted DTO for a worker lane (requires a configured endpoint). */
export function laneToUntrustedDTO(lane: Lane): UntrustedLaneDTO {
  if (!lane.endpoint) throw new Error(`worker lane "${lane.id}" has no endpoint configured`);
  return { id: lane.id, model: lane.model, endpoint: lane.endpoint, authHandle: lane.authHandle ?? '' };
}

/** Build the narrow DTO for a reader lane (requires a configured endpoint; API-only in v1). */
export function laneToReaderDTO(lane: Lane): UntrustedLaneDTO {
  if (!lane.endpoint) throw new Error(`reader lane "${lane.id}" has no endpoint configured`);
  return { id: lane.id, model: lane.model, endpoint: lane.endpoint, authHandle: lane.authHandle ?? '' };
}

/** Options for {@link runAndRecord}. */
export interface RunAndRecordOptions {
  ledger: JsonlLedger;
  priceTable: PriceTable;
  executeTrusted?: RunDeps['executeTrusted'];
  scanSecrets?: RunDeps['scanSecrets'];
  resolveAuth?: (authHandle: string) => string;
}

/**
 * Wire {@link runTask} with the real executors + gitleaks scanner, run the task,
 * and append its content-free events to the ledger. Returns the run result.
 */
export async function runAndRecord(
  request: RunRequest,
  ctx: RouteContext,
  policy: Policy,
  opts: RunAndRecordOptions,
): Promise<RunResult> {
  const resolveAuth = opts.resolveAuth;
  const deps: RunDeps = {
    executeTrusted:
      opts.executeTrusted ??
      makeTrustedExecutor(resolveAuth ? { api: makeTrustedApiExecutor({ resolveAuth }) } : {}),
    executeUntrusted: (env) => executeUntrusted(env, resolveAuth ? { resolveAuth } : {}),
    untrustedLaneDTO: laneToUntrustedDTO,
    executeReader: (env) => executeReader(env, resolveAuth ? { resolveAuth } : {}),
    readerLaneDTO: laneToReaderDTO,
    scanSecrets: opts.scanSecrets ?? makeGitleaksScanner(),
    priceTable: opts.priceTable,
    newId: () => randomUUID(),
  };
  const result = await runTask(request, ctx, policy, deps);
  for (const event of result.events) opts.ledger.appendTask(event);
  return result;
}
