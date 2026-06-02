import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { EVENT_FIELDS, LedgerError } from '../src/ledger.ts';
import type { OutcomeEventInput, TaskEventInput } from '../src/ledger.ts';
import { JsonlLedger } from '../src/node.ts';

function tempLedgerPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-'));
  return { dir, path: join(dir, 'ledger.jsonl') };
}

const INPUT: TaskEventInput = {
  task_id: 't-0',
  attempt: 0,
  category: 'bugfix',
  laneId: 'codex-cli',
  model: 'gpt-5.5',
  trust_mode: 'full',
  provenance: 'openai',
  status: 'ok',
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

const OUTCOME_INPUT: OutcomeEventInput = {
  subject_id: 't-0',
  subject_type: 'router_task',
  task_id: 't-0',
  review_id: 'r-0',
  attempt: 0,
  category: 'bugfix',
  reviewer_lane_id: 'claude-native',
  reviewer_model: 'claude-opus-4-7',
  reviewer_trust_mode: 'full',
  reviewer_provenance: 'anthropic',
  verdict: 'pass',
  voter: 'reviewer_model',
  policy_verdict: 'allow',
};

test('append assigns id/seq/ts and persists; readAll round-trips', () => {
  const { dir, path } = tempLedgerPath();
  try {
    const ledger = new JsonlLedger(path);
    const a = ledger.appendTask(INPUT);
    const b = ledger.appendTask({ ...INPUT, model: 'llama3.1:8b', laneId: 'ollama' });

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
    ledger.appendTask({ ...INPUT, prompt: 'secret', filePath: '/repo/secrets.ts' } as TaskEventInput);
    const raw = readFileSync(path, 'utf8').trim();
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const allow = new Set<string>(EVENT_FIELDS);
    for (const key of Object.keys(obj)) {
      assert.ok(allow.has(key), `unexpected on-disk field ${key}`);
      assert.doesNotMatch(key, /prompt|content|code|payload|snippet|text|path|repo|diff|secret/i);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh ledger instance reads existing events and continues the sequence', () => {
  const { dir, path } = tempLedgerPath();
  try {
    new JsonlLedger(path).appendTask(INPUT);
    new JsonlLedger(path).appendTask(INPUT);

    const reopened = new JsonlLedger(path);
    assert.equal(reopened.readAll().length, 2);
    const next = reopened.appendTask(INPUT);
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
    new JsonlLedger(path).appendTask(INPUT);
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\n$/, ''), 'utf8');

    // A fresh instance appends; it must not concatenate onto the unterminated line.
    new JsonlLedger(path).appendTask({ ...INPUT, model: 'llama3.1:8b' });

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
    ledger.appendTask(INPUT);
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
    ledger.appendTask(INPUT);
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
    const a = ledger.appendTask(INPUT);
    assert.ok(Object.isFrozen(a));
    assert.throws(() => {
      (a as { seq: number }).seq = 999;
    });
    // The next seq is unaffected by attempted mutation.
    assert.equal(ledger.appendTask(INPUT).seq, 1);
    assert.ok(Object.isFrozen(ledger.readAll()[0]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendOutcome persists outcome events, sharing the monotonic sequence with tasks', () => {
  const { dir, path } = tempLedgerPath();
  try {
    const ledger = new JsonlLedger(path);
    const t = ledger.appendTask(INPUT);
    const o = ledger.appendOutcome(OUTCOME_INPUT);
    assert.equal(t.seq, 0);
    assert.equal(o.seq, 1);
    assert.equal(o.event_type, 'outcome');
    assert.equal(o.verdict, 'pass');

    const reread = new JsonlLedger(path).readAll();
    assert.equal(reread.length, 2);
    assert.equal(reread[0]?.event_type, 'task');
    assert.equal(reread[1]?.event_type, 'outcome');
    assert.deepEqual(reread[1], o);
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
    for (let i = 0; i < 50; i++) ids.add(ledger.appendTask(INPUT).id);
    assert.equal(ids.size, 50);
    assert.notEqual(randomUUID(), randomUUID()); // sanity: source of ids is unique
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
