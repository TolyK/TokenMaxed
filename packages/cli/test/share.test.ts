/**
 * D (hosted step) — the opt-in share flow: contributor identity lifecycle,
 * ISO-week windows, payload build against the trusted catalog, the
 * consent/preview contract (default sends NOTHING), and the upload client.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LeaderboardRow } from '@tokenmaxed/core';
import {
  CONSENT_COPY,
  buildSharePayload,
  formatSharePreview,
  isoWeekId,
  isoWeekStartMs,
  nextRevision,
  readOrCreateContributor,
  recordRevision,
  rotateContributor,
  uploadSnapshot,
} from '../src/share.ts';
import type { ContributorStore, FetchLike } from '../src/share.ts';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const UUID2 = '223e4567-e89b-42d3-a456-426614174000';

function memStore(initial?: string): { store: ContributorStore; writes: string[] } {
  const writes: string[] = [];
  let current = initial;
  return {
    writes,
    store: {
      read: () => current,
      write: (text) => {
        current = text;
        writes.push(text);
      },
    },
  };
}

const row = (over: Partial<LeaderboardRow> = {}): LeaderboardRow =>
  ({
    model: 'gpt-5.5',
    category: 'bugfix',
    difficulty: 'easy',
    pass: 3,
    needs_rework: 1,
    fail: 0,
    tokens_in: 1000,
    tokens_out: 500,
    ...over,
  }) as LeaderboardRow;

// --- contributor identity ------------------------------------------------------

test('readOrCreateContributor: creates + persists once; subsequent reads reuse', () => {
  const { store, writes } = memStore();
  const a = readOrCreateContributor(store, () => UUID, () => '2026-07-12T00:00:00Z');
  assert.equal(a.contributor_id, UUID);
  assert.equal(writes.length, 1);
  const b = readOrCreateContributor(store, () => UUID2, () => 'later');
  assert.equal(b.contributor_id, UUID); // reused, not regenerated
  assert.equal(writes.length, 1);
});

test('readOrCreateContributor: corruption or a non-UUID id recreates a FRESH identity', () => {
  for (const bad of ['not json', JSON.stringify({ contributor_id: 'chosen-name', revisions: {} })]) {
    const { store } = memStore(bad);
    const state = readOrCreateContributor(store, () => UUID, () => 'now');
    assert.equal(state.contributor_id, UUID);
  }
});

test('rotateContributor: fresh id, EMPTY revisions (old uploads stay under the old id)', () => {
  const { store } = memStore(JSON.stringify({ contributor_id: UUID, created: 'x', revisions: { '2026-W28': 3 } }));
  const rotated = rotateContributor(store, () => UUID2, () => 'now');
  assert.equal(rotated.contributor_id, UUID2);
  assert.deepEqual(rotated.revisions, {});
});

test('revisions: monotonic per window; recordRevision persists', () => {
  const { store } = memStore();
  let state = readOrCreateContributor(store, () => UUID, () => 'now');
  assert.equal(nextRevision(state, '2026-W28'), 1);
  state = recordRevision(store, state, '2026-W28', 1);
  assert.equal(nextRevision(state, '2026-W28'), 2);
  assert.equal(nextRevision(state, '2026-W29'), 1); // windows are independent
  const reread = readOrCreateContributor(store, () => UUID2, () => 'later');
  assert.equal(reread.revisions['2026-W28'], 1); // persisted
});

// --- ISO weeks -------------------------------------------------------------------

test('isoWeekId: known fixtures incl. year-boundary weeks', () => {
  assert.equal(isoWeekId(Date.UTC(2026, 6, 12)), '2026-W28'); // 2026-07-12 (Sun of W28)
  assert.equal(isoWeekId(Date.UTC(2026, 0, 1)), '2026-W01'); // Thu 2026-01-01
  assert.equal(isoWeekId(Date.UTC(2027, 0, 1)), '2026-W53'); // Fri 2027-01-01 belongs to 2026's W53
  assert.equal(isoWeekId(Date.UTC(2024, 11, 30)), '2025-W01'); // Mon 2024-12-30 belongs to 2025-W01
});

test('isoWeekStartMs: the Monday 00:00Z of the containing ISO week', () => {
  const start = isoWeekStartMs(Date.UTC(2026, 6, 12, 15, 30)); // Sun 2026-07-12
  assert.equal(new Date(start).toISOString(), '2026-07-06T00:00:00.000Z'); // Mon of W28
  assert.equal(isoWeekId(start), isoWeekId(Date.UTC(2026, 6, 12)));
});

// --- payload + preview -------------------------------------------------------------

test('buildSharePayload: canonical bytes carry the contributor/window/revision; unknown models throw', () => {
  const state = { contributor_id: UUID, created: 'x', revisions: {} };
  const payload = buildSharePayload([row()], state, Date.UTC(2026, 6, 12), new Set(['gpt-5.5']));
  assert.equal(payload.windowId, '2026-W28');
  assert.equal(payload.revision, 1);
  const parsed = JSON.parse(payload.serialized) as { contributor_id: string; rows: unknown[] };
  assert.equal(parsed.contributor_id, UUID);
  assert.equal(parsed.rows.length, 1);
  // A model outside the trusted catalog is refused CLIENT-side too.
  assert.throws(() => buildSharePayload([row({ model: 'mystery-model' })], state, Date.UTC(2026, 6, 12), new Set(['gpt-5.5'])));
});

test('the consent copy carries the operator-approved claims', () => {
  assert.match(CONSENT_COPY, /never see your code or your prompts/i);
  assert.match(CONSENT_COPY, /success rate/i);
  assert.match(CONSENT_COPY, /category and difficulty/i);
  assert.match(CONSENT_COPY, /rotate-id/);
  assert.match(CONSENT_COPY, /5 distinct contributors/);
  assert.match(CONSENT_COPY, /no background sharing/i);
});

test('formatSharePreview: shows the EXACT payload + the no-send default; unconfigured endpoint is loud', () => {
  const state = { contributor_id: UUID, created: 'x', revisions: {} };
  const payload = buildSharePayload([row()], state, Date.UTC(2026, 6, 12), new Set(['gpt-5.5']));
  const noEndpoint = formatSharePreview(payload, {});
  assert.ok(noEndpoint.includes(payload.serialized)); // the exact bytes, verbatim
  assert.match(noEndpoint, /NOT CONFIGURED/);
  assert.match(noEndpoint, /Nothing was sent/);
  const withEndpoint = formatSharePreview(payload, { endpoint: 'https://example.test/api/submit' });
  assert.match(withEndpoint, /--yes rebuilds and uploads the CURRENT week/);
});

// --- upload client -------------------------------------------------------------------

test('uploadSnapshot: POSTs the exact bytes; ok / rejected / network-error results, never throws', async () => {
  const calls: Array<{ url: string; body: string; method: string }> = [];
  const okFetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body, method: init.method });
    return { ok: true, status: 200, text: async () => '' };
  };
  const r1 = await uploadSnapshot(okFetch, 'https://x/api/submit', '{"a":1}');
  assert.deepEqual(r1, { ok: true, status: 200 });
  assert.deepEqual(calls[0], { url: 'https://x/api/submit', body: '{"a":1}', method: 'POST' });

  const rejectedFetch: FetchLike = async () => ({ ok: false, status: 422, text: async () => 'unknown model' });
  const r2 = await uploadSnapshot(rejectedFetch, 'https://x', '{}');
  assert.equal(r2.ok, false);
  assert.match((r2 as { message: string }).message, /422.*unknown model/s);

  const brokenFetch: FetchLike = async () => {
    throw new Error('ECONNREFUSED');
  };
  const r3 = await uploadSnapshot(brokenFetch, 'https://x', '{}');
  assert.equal(r3.ok, false);
  assert.match((r3 as { message: string }).message, /ECONNREFUSED/);
});
