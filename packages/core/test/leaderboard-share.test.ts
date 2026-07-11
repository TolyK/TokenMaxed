/**
 * D (P6 §6/§6.5) — the share boundary: the allowlist serializer (content-free
 * by construction), replace-by-snapshot merge (idempotent re-upload, distinct
 * contributors, associativity/commutativity), and MIN_USERS/MIN_TOTAL
 * publication suppression.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MIN_TOTAL,
  MIN_USERS,
  SHARE_ROW_FIELDS,
  SHARE_SNAPSHOT_FIELDS,
  mergeShareSnapshots,
  publishLeaderboard,
  serializeShareSnapshot,
  shareSnapshotFromRows,
} from '../src/leaderboard-share.ts';
import type { ShareRow, ShareSnapshot } from '../src/leaderboard-share.ts';
import type { LeaderboardRow } from '../src/leaderboard.ts';

const row = (over: Partial<ShareRow> = {}): ShareRow => ({
  model: 'gpt-5.5',
  category: 'bugfix',
  difficulty: 'hard',
  pass: 8,
  needs_rework: 2,
  fail: 1,
  tokens_in: 1000,
  tokens_out: 500,
  ...over,
});

/** Deterministic UUIDv4-shaped ids for tests (c1 → …0001 etc.). */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CONTRIBUTORS: Record<string, string> = {
  local: 'local', c0: uuid(0), c1: uuid(1), c2: uuid(2), c3: uuid(3), c4: uuid(4),
};
const snap = (contributor: string, over: Partial<ShareSnapshot> = {}): ShareSnapshot => ({
  contributor_id: CONTRIBUTORS[contributor] ?? contributor,
  window_id: '2026-W28',
  revision: 1,
  rows: [row()],
  ...over,
});

const CATALOG = new Set(['gpt-5.5']);

test('operator decision constants: MIN_USERS = 5, MIN_TOTAL = 10', () => {
  assert.equal(MIN_USERS, 5);
  assert.equal(MIN_TOTAL, 10);
});

test('serializer: ONLY allowlisted fields cross the boundary — extras are dropped by construction', () => {
  const dirty = snap('c1');
  // Simulate hostile/buggy extra properties on both levels.
  (dirty as unknown as Record<string, unknown>).instruction = 'SECRET PROMPT TEXT';
  (dirty.rows[0] as unknown as Record<string, unknown>).notes = 'leaked review text';
  const wire = serializeShareSnapshot(dirty, { knownModels: CATALOG });
  assert.doesNotMatch(wire, /SECRET|leaked/);
  const parsed = JSON.parse(wire);
  assert.deepEqual(Object.keys(parsed).sort(), [...SHARE_SNAPSHOT_FIELDS].sort());
  assert.deepEqual(Object.keys(parsed.rows[0]).sort(), [...SHARE_ROW_FIELDS].sort());
});

test('shareSnapshotFromRows drops the derived leaderboard fields (users/total/passRate)', () => {
  const lRow: LeaderboardRow = {
    model: 'gpt-5.5', category: 'bugfix', difficulty: 'hard',
    pass: 8, needs_rework: 2, fail: 1, total: 11, passRate: 0.5,
    tokens_in: 1000, tokens_out: 500, users: 1,
  };
  const s = shareSnapshotFromRows([lRow], { contributor_id: uuid(1), window_id: '2026-W28', revision: 1 });
  const wire = JSON.parse(serializeShareSnapshot(s, { knownModels: CATALOG }));
  assert.equal(wire.rows[0].users, undefined);
  assert.equal(wire.rows[0].total, undefined);
  assert.equal(wire.rows[0].passRate, undefined);
});

test('merge: re-upload REPLACES (never adds) — idempotent per (contributor, window)', () => {
  const v1 = snap('c1', { revision: 1, rows: [row({ pass: 8 })] });
  const v2 = snap('c1', { revision: 2, rows: [row({ pass: 9 })] });
  const once = mergeShareSnapshots([v2], { localOnly: true });
  const withStale = mergeShareSnapshots([v1, v2, v1, v2], { localOnly: true }); // any order, duplicates included
  assert.deepEqual(withStale, once);
  assert.equal(once[0]!.pass, 9); // the revision-2 value, not 8, not 17
  assert.equal(once[0]!.users, 1);
});

test('merge: distinct contributors SUM; users counts contributors, not uploads', () => {
  const merged = mergeShareSnapshots([
    snap('c1', { rows: [row({ pass: 8 })] }),
    snap('c2', { rows: [row({ pass: 4 })] }),
    snap('c2', { revision: 2, rows: [row({ pass: 5 })] }), // replaces c2's first
  ], { localOnly: true });
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.pass, 13); // 8 + 5
  assert.equal(merged[0]!.users, 2);
});

test('merge is associative/commutative over the retained set', () => {
  const snaps = [snap('c1'), snap('c2', { rows: [row({ pass: 3, tokens_in: 10 })] }), snap('c3', { rows: [row({ category: 'docs' })] })];
  const all = mergeShareSnapshots(snaps, { localOnly: true });
  const reversed = mergeShareSnapshots([...snaps].reverse(), { localOnly: true });
  assert.deepEqual(all, reversed);
});

test('publish: suppression at the exact MIN_USERS and MIN_TOTAL boundaries', () => {
  const mk = (users: number, pass: number) =>
    mergeShareSnapshots(
      Array.from({ length: users }, (_, i) => snap(`c${i}`, { rows: [row({ pass, needs_rework: 0, fail: 0 })] })),
      { localOnly: true },
    );
  // 5 users × 2 verdicts each = 10 total ⇒ published exactly at both bars.
  assert.equal(publishLeaderboard(mk(5, 2)).length, 1);
  // 4 users ⇒ suppressed regardless of volume.
  assert.equal(publishLeaderboard(mk(4, 100)).length, 0);
  // 5 users but only 9 verdicts ⇒ suppressed (thin cell).
  const nine = mergeShareSnapshots([
    ...Array.from({ length: 4 }, (_, i) => snap(`c${i}`, { rows: [row({ pass: 2, needs_rework: 0, fail: 0 })] })),
    snap('c4', { rows: [row({ pass: 1, needs_rework: 0, fail: 0 })] }),
  ], { localOnly: true });
  assert.equal(publishLeaderboard(nine).length, 0);
});

test('publish: the local N=1 view is NOT the published view (suppression is a publication property)', () => {
  const local = mergeShareSnapshots([snap('local')], { localOnly: true });
  assert.equal(local.length, 1); // local chart renders fine at N=1…
  assert.equal(publishLeaderboard(local).length, 0); // …but publishes nothing
});

// --- adversarial value validation (round-2 blockers) --------------------------------

import { validateShareSnapshot } from '../src/leaderboard-share.ts';

test('validator: hostile content in ALLOWLISTED fields is rejected (values, not just names)', () => {
  const hostile = [
    snap('c1', { contributor_id: 'SECRET_PROMPT_TEXT' }), // compact secret ⇒ not a UUIDv4
    snap('c1', { contributor_id: 'PRIVATE-API-KEY-b64QUJDREVG' }),
    snap('c1', { window_id: 'PRIVATE_API_KEY' }), // not an ISO week
    snap('c1', { window_id: 'w'.repeat(40) }),
    snap('c1', { rows: [row({ model: 'a model with free text in it!!' })] }),
    snap('c1', { rows: [row({ category: 'not-a-category' as never })] }),
    snap('c1', { rows: [row({ difficulty: 'impossible' as never })] }),
    snap('c1', { rows: [row({ pass: -1 })] }),
    snap('c1', { rows: [row({ tokens_in: 1.5 })] }),
    snap('c1', { rows: [row({ fail: Number.NaN })] }),
    snap('c1', { rows: [row({ pass: '8' as never })] }),
    snap('c1', { revision: 0 }),
    snap('c1', { rows: [row(), row()] }), // duplicate cell key
  ];
  for (const s of hostile) {
    assert.equal(validateShareSnapshot(s).valid, false);
    assert.throws(() => serializeShareSnapshot(s, { knownModels: CATALOG }), /refusing to serialize/);
    assert.deepEqual(mergeShareSnapshots([s], { localOnly: true }), []); // merge ignores it (fail closed)
  }
});

test('validator: a toJSON()-armed value cannot smuggle content through serialization', () => {
  const armed = snap('c1');
  (armed.rows[0] as unknown as Record<string, unknown>).model = { toJSON: () => 'SMUGGLED TEXT' };
  assert.equal(validateShareSnapshot(armed).valid, false); // non-string model rejected
  assert.throws(() => serializeShareSnapshot(armed, { knownModels: CATALOG }));
});

test('merge: equal-revision conflicts resolve deterministically in ANY input order', () => {
  const a = snap('c1', { revision: 3, rows: [row({ pass: 8 })] });
  const b = snap('c1', { revision: 3, rows: [row({ pass: 5 })] });
  const ab = mergeShareSnapshots([a, b], { localOnly: true });
  const ba = mergeShareSnapshots([b, a], { localOnly: true });
  assert.deepEqual(ab, ba); // order-independent
  assert.equal(ab.length, 1); // one winner, never a sum
  assert.ok(ab[0]!.pass === 8 || ab[0]!.pass === 5);
});

test('merge: canonicalized row order means identical content ties are true duplicates', () => {
  const r1 = row({ category: 'bugfix' });
  const r2 = row({ category: 'docs' });
  const forward = snap('c1', { rows: [r1, r2] });
  const backward = snap('c1', { rows: [r2, r1] });
  assert.deepEqual(mergeShareSnapshots([forward, backward], { localOnly: true }), mergeShareSnapshots([forward], { localOnly: true }));
});

test('provenance: ids are structural (UUIDv4 + ISO week); the local sentinel never wires; models gate on the catalog', () => {
  // A wire-valid snapshot: generated UUID + ISO week.
  const wire = snap('c1'); // uuid contributor, 2026-W28 window
  assert.equal(validateShareSnapshot(wire).valid, true);
  assert.doesNotMatch(serializeShareSnapshot(wire, { knownModels: CATALOG }), /local/);
  // The local sentinel renders locally but REFUSES to serialize.
  const local = snap('local', { window_id: 'local' });
  assert.equal(validateShareSnapshot(local).valid, true); // fine on-machine
  assert.throws(() => serializeShareSnapshot(local, { knownModels: CATALOG }), /refusing to serialize the local sentinel/);
  // Catalog membership: a charset-legal but unknown model is rejected when a
  // trusted catalog is supplied (the server-side posture).
  const planted = snap('c1', { rows: [row({ model: 'SECRET.PROMPT.TEXT' })] });
  const catalog = new Set(['gpt-5.5']);
  assert.equal(validateShareSnapshot(planted, { knownModels: catalog }).valid, false);
  assert.throws(() => serializeShareSnapshot(planted, { knownModels: catalog }), /trusted model catalog/);
  assert.deepEqual(mergeShareSnapshots([planted], { knownModels: catalog }), []);
  assert.equal(validateShareSnapshot(wire, { knownModels: catalog }).valid, true);
});

test('validator/merge never throw on hostile runtime shapes (null, primitives, null rows, throwing getters)', () => {
  const throwing = {} as ShareSnapshot;
  Object.defineProperty(throwing, 'contributor_id', { get() { throw new Error('boom'); } });
  const hostile: unknown[] = [null, 42, 'text', [], { rows: null }, snap('c1', { rows: [null as never] }), throwing];
  for (const h of hostile) {
    assert.equal(validateShareSnapshot(h).valid, false); // never throws
  }
  // One bad payload can never abort the whole merge.
  const merged = mergeShareSnapshots([...hostile, snap('c1')], { localOnly: true });
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.users, 1);
});

test('TOCTOU: a getter that turns hostile AFTER validation cannot reach the wire (single-read)', () => {
  let reads = 0;
  const shifty = snap('c1');
  Object.defineProperty(shifty.rows[0], 'model', {
    get() {
      reads += 1;
      return reads === 1 ? 'gpt-5.5' : 'SECRET_PROMPT_TEXT';
    },
  });
  const wire = serializeShareSnapshot(shifty, { knownModels: CATALOG });
  assert.doesNotMatch(wire, /SECRET/);
  assert.match(wire, /gpt-5\.5/); // the single validated read is what shipped
});
