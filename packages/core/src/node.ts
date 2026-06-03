/**
 * Node-specific adapters for the routing brain.
 *
 * Exposed as the `@tokenmaxed/core/node` subpath. File I/O lives here, not in
 * the host-agnostic core barrel, so consumers that only need the pure routing
 * APIs never pull in `node:fs`.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LaneConfigError, LaneRegistry, parseLaneConfig } from './registry.ts';
import { PriceError, validatePriceTable } from './price.ts';
import type { PriceTable } from './price.ts';
import { PolicyConfigError, parsePolicyConfig } from './policy.ts';
import { isMinimizedPayload } from './minimize.ts';
import type { SecretScanner } from './minimize.ts';
import { buildUntrustedRequestBody } from './boundary.ts';
import type { SafeUntrustedEnvelope, UntrustedLaneDTO } from './boundary.ts';
import type { RawUsage } from './usage.ts';
import { runTask } from './run.ts';
import type { RunDeps, RunRequest, RunResult, TrustedExecResult } from './run.ts';
import type { Lane, Policy, RouteContext } from './types.ts';
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
}
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<FetchLikeResponse>;

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
  error?: string;
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

  try {
    // Auth resolution + body build are part of the egress path: any failure here
    // (e.g. a missing/locked keychain entry) must also fail content-free.
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (env.lane.authHandle) {
      // A non-empty authHandle means auth is required: fail closed (before sending)
      // if it cannot be resolved to a token.
      const token = deps.resolveAuth ? deps.resolveAuth(env.lane.authHandle) : '';
      if (!token) return { ok: false, error: 'auth resolution failed for untrusted lane' };
      headers.authorization = `Bearer ${token}`;
    }
    const body = JSON.stringify(buildUntrustedRequestBody(env));

    const res = await doFetch(env.lane.endpoint, { method: 'POST', headers, body });
    if (!res.ok) return { ok: false, error: `untrusted lane returned status ${res.status}` };
    const data = await res.json();
    return { ok: true, resultText: extractText(data), reported: extractUsage(data) };
  } catch {
    // Content-free: never surface payload/repo text (or a resolver's raw error).
    return { ok: false, error: 'untrusted lane request failed' };
  }
}

/** Default ledger location: `~/.tokenmaxed/ledger.jsonl`. */
export function defaultLedgerPath(): string {
  return join(homedir(), '.tokenmaxed', 'ledger.jsonl');
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
) => { status: number | null; stdout?: string; error?: Error };

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

export function makeCliExecutor(spawnImpl?: SpawnLike): TrustedExecFn {
  const spawn: SpawnLike =
    spawnImpl ?? ((cmd, args, opts) => spawnSync(cmd, [...args], opts) as ReturnType<SpawnLike>);
  return async (lane, instruction, attachments) => {
    if (!lane.command) throw new Error(`cli lane "${lane.id}" has no command configured`);
    const input = combinedPrompt(instruction, attachments);
    const res = spawn(lane.command, lane.args ?? [], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (res.error) throw new Error(`cli lane "${lane.id}" failed to spawn`);
    if (res.status !== 0) throw new Error(`cli lane "${lane.id}" exited with status ${res.status}`);
    return { resultText: res.stdout ?? '' }; // CLIs rarely report tokens ⇒ estimated downstream
  };
}

type OllamaFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<FetchLikeResponse>;

/** Local Ollama executor: POST /api/generate; uses reported eval counts when present. */
export function makeOllamaExecutor(fetchImpl?: OllamaFetch): TrustedExecFn {
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as OllamaFetch);
  return async (lane, instruction, attachments) => {
    const base = lane.endpoint ?? 'http://localhost:11434';
    const res = await doFetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: lane.model, prompt: combinedPrompt(instruction, attachments), stream: false }),
    });
    if (!res.ok) throw new Error(`ollama lane "${lane.id}" returned status ${res.status}`);
    const data = (await res.json()) as { response?: unknown; prompt_eval_count?: unknown; eval_count?: unknown };
    return {
      resultText: typeof data.response === 'string' ? data.response : '',
      reported: { tokens_in: numOrUndef(data.prompt_eval_count), tokens_out: numOrUndef(data.eval_count) },
    };
  };
}

/**
 * Trusted API executor (OpenAI-compatible): sends the FULL instruction +
 * attachments (no minimization — a `full`/trusted lane the user approved). Auth
 * is resolved from the lane's authHandle; a lane that needs auth without a
 * resolver fails closed (throws ⇒ runTask degrades).
 */
export function makeTrustedApiExecutor(
  deps: { fetchImpl?: FetchLike; resolveAuth?: (authHandle: string) => string } = {},
): TrustedExecFn {
  const doFetch = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  return async (lane, instruction, attachments) => {
    if (!lane.endpoint) throw new Error(`api lane "${lane.id}" has no endpoint configured`);
    if (!doFetch) throw new Error('no fetch implementation available');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (lane.authHandle) {
      const token = deps.resolveAuth ? deps.resolveAuth(lane.authHandle) : '';
      if (!token) throw new Error(`auth resolution failed for api lane "${lane.id}"`);
      headers.authorization = `Bearer ${token}`;
    }
    const body = JSON.stringify({
      model: lane.model,
      messages: [{ role: 'user', content: combinedPrompt(instruction, attachments) }],
    });
    const res = await doFetch(lane.endpoint, { method: 'POST', headers, body });
    if (!res.ok) throw new Error(`api lane "${lane.id}" returned status ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[]; usage?: Record<string, unknown> };
    const content = data.choices?.[0]?.message?.content;
    return {
      resultText: typeof content === 'string' ? content : '',
      reported: { tokens_in: numOrUndef(data.usage?.prompt_tokens), tokens_out: numOrUndef(data.usage?.completion_tokens) },
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
    scanSecrets: opts.scanSecrets ?? makeGitleaksScanner(),
    priceTable: opts.priceTable,
    newId: () => randomUUID(),
  };
  const result = await runTask(request, ctx, policy, deps);
  for (const event of result.events) opts.ledger.appendTask(event);
  return result;
}
