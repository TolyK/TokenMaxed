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
import type { Policy } from './types.ts';
import type { SecretScanner } from './minimize.ts';
import { LedgerError, parseEvent, serializeEvent, validateEventInput } from './ledger.ts';
import type { TaskEvent, TaskEventInput } from './ledger.ts';

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
  #events: TaskEvent[] | null = null;
  /** Whether the on-disk file is empty or already ends with a newline. */
  #fileEndsWithNewline = true;

  constructor(path: string = defaultLedgerPath()) {
    this.path = path;
  }

  #load(): TaskEvent[] {
    if (this.#events) return this.#events;
    if (!existsSync(this.path)) {
      this.#events = [];
      return this.#events;
    }
    const text = readFileSync(this.path, 'utf8');
    // If a pre-existing file's last record lacks a trailing newline, the next
    // append must insert one first or it would concatenate onto that line.
    this.#fileEndsWithNewline = text === '' || text.endsWith('\n');
    const events: TaskEvent[] = [];
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
      // Freeze cached events so a reference handed back via readAll()/append()
      // cannot be mutated to corrupt later summaries or seq assignment.
      events.push(Object.freeze(parseEvent(obj)));
    }
    this.#events = events;
    return events;
  }

  /** All events currently in the ledger (a defensive copy). */
  readAll(): TaskEvent[] {
    return [...this.#load()];
  }

  /** Append one task event; returns the persisted event with its id/seq/ts. */
  append(input: TaskEventInput): TaskEvent {
    const events = this.#load();
    const nextSeq = events.reduce((max, e) => Math.max(max, e.seq), -1) + 1;
    const event: TaskEvent = Object.freeze({
      id: randomUUID(),
      seq: nextSeq,
      ts: new Date().toISOString(),
      ...validateEventInput(input),
    });
    mkdirSync(dirname(this.path), { recursive: true });
    const prefix = this.#fileEndsWithNewline ? '' : '\n';
    appendFileSync(this.path, prefix + serializeEvent(event) + '\n', 'utf8');
    this.#fileEndsWithNewline = true;
    events.push(event);
    return event;
  }
}
