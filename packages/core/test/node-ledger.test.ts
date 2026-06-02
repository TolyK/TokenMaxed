import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { EVENT_FIELDS, LedgerError } from '../src/ledger.ts';
import type { TaskEventInput } from '../src/ledger.ts';
import { JsonlLedger } from '../src/node.ts';

function tempLedgerPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-'));
  return { dir, path: join(dir, 'ledger.jsonl') };
}

const INPUT: TaskEventInput = {
  category: 'bugfix',
  laneId: 'codex-cli',
  model: 'gpt-5.5',
  tokens_in: 100,
  tokens_out: 50,
  tokens_estimated: false,
  actual_cost: 0,
  frontier_cost: 1,
  metered_spent: 0,
  frontier_avoided: 1,
  metered_avoided: 1,
  policy_verdict: 'allow',
};

test('append assigns id/seq/ts and persists; readAll round-trips', () => {
  const { dir, path } = tempLedgerPath();
  try {
    const ledger = new JsonlLedger(path);
    const a = ledger.append(INPUT);
    const b = ledger.append({ ...INPUT, model: 'llama3.1:8b', laneId: 'ollama' });

    assert.equal(a.seq, 0);
    assert.equal(b.seq, 1);
    assert.notEqual(a.id, b.id);
    assert.match(a.ts, /^\d{4}-\d{2}-\d{2}T/);

    const all = ledger.readAll();
    assert.equal(all.length, 2);
    assert.deepEqual(all[0], a);
    assert.deepEqual(all[1], b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('on-disk lines contain only the allowlisted (content-free) fields', () => {
  const { dir, path } = tempLedgerPath();
  try {
    const ledger = new JsonlLedger(path);
    // Even if a caller smuggles extra fields, they must not reach disk.
    ledger.append({ ...INPUT, prompt: 'secret', filePath: '/repo/secrets.ts' } as TaskEventInput);
    const raw = readFileSync(path, 'utf8').trim();
    const obj = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(obj), [...EVENT_FIELDS]);
    for (const key of Object.keys(obj)) {
      assert.doesNotMatch(key, /prompt|content|code|payload|snippet|text|path|repo|diff|secret/i);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh ledger instance reads existing events and continues the sequence', () => {
  const { dir, path } = tempLedgerPath();
  try {
    new JsonlLedger(path).append(INPUT);
    new JsonlLedger(path).append(INPUT);

    const reopened = new JsonlLedger(path);
    assert.equal(reopened.readAll().length, 2);
    const next = reopened.append(INPUT);
    assert.equal(next.seq, 2);
    assert.equal(reopened.readAll().length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append inserts a separator when the existing file lacks a trailing newline', () => {
  const { dir, path } = tempLedgerPath();
  try {
    // Seed one valid record, then strip its trailing newline (as another tool might).
    new JsonlLedger(path).append(INPUT);
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\n$/, ''), 'utf8');

    // A fresh instance appends; it must not concatenate onto the unterminated line.
    new JsonlLedger(path).append({ ...INPUT, model: 'llama3.1:8b' });

    const reread = new JsonlLedger(path).readAll();
    assert.equal(reread.length, 2);
    assert.equal(reread[0]?.seq, 0);
    assert.equal(reread[1]?.seq, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readAll on a non-existent ledger returns empty (no throw)', () => {
  const { dir, path } = tempLedgerPath();
  try {
    const ledger = new JsonlLedger(join(path, 'does-not-exist.jsonl'));
    assert.deepEqual(ledger.readAll(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt ledger line raises a clear LedgerError with the line number', () => {
  const { dir, path } = tempLedgerPath();
  try {
    const ledger = new JsonlLedger(path);
    ledger.append(INPUT);
    // Append a junk line out of band, then force a re-read with a new instance.
    appendFileSync(path, 'not json\n', 'utf8');
    assert.throws(() => new JsonlLedger(path).readAll(), {
      name: 'LedgerError',
      message: /invalid JSON on line 2/,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readAll returns a defensive copy (mutating it does not affect the ledger)', () => {
  const { dir, path } = tempLedgerPath();
  try {
    const ledger = new JsonlLedger(path);
    ledger.append(INPUT);
    const first = ledger.readAll();
    first.pop();
    assert.equal(ledger.readAll().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('returned events are frozen, so mutating one cannot corrupt seq or stats', () => {
  const { dir, path } = tempLedgerPath();
  try {
    const ledger = new JsonlLedger(path);
    const a = ledger.append(INPUT);
    assert.ok(Object.isFrozen(a));
    assert.throws(() => {
      (a as { seq: number }).seq = 999;
    });
    // The next seq is unaffected by attempted mutation.
    assert.equal(ledger.append(INPUT).seq, 1);
    assert.ok(Object.isFrozen(ledger.readAll()[0]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Unique-id sanity across many appends (no collisions).
test('appends generate unique ids', () => {
  const { dir, path } = tempLedgerPath();
  try {
    const ledger = new JsonlLedger(path);
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(ledger.append(INPUT).id);
    assert.equal(ids.size, 50);
    assert.notEqual(randomUUID(), randomUUID()); // sanity: source of ids is unique
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
