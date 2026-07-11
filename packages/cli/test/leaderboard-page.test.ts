/**
 * D — the standalone leaderboard page: local vs published mode honesty,
 * verbatim caveat, N visibility, empty states, escaping, self-containment.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MIN_USERS, mergeShareSnapshots } from '../../core/src/index.ts';
import type { ShareSnapshot } from '../../core/src/index.ts';

import { LEADERBOARD_CAVEAT, renderLeaderboardPage } from '../src/leaderboard-page.ts';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const snap = (contributor: string, model = 'gpt-5.5'): ShareSnapshot => ({
  contributor_id: contributor === 'local' ? 'local' : uuid(1),
  window_id: contributor === 'local' ? 'local' : '2026-W28',
  revision: 1,
  rows: [{ model, category: 'bugfix', difficulty: 'hard', pass: 8, needs_rework: 2, fail: 1, tokens_in: 1000, tokens_out: 500 }],
});

const AT = '2026-07-11T12:00:00.000Z';

test('local mode: unsuppressed, loudly labeled, caveat verbatim, N shown', () => {
  const cells = mergeShareSnapshots([snap('local')], { localOnly: true });
  const html = renderLeaderboardPage(cells, { mode: 'local', generatedAtIso: AT });
  assert.match(html, /LOCAL VIEW — your own ledger only \(N=1\)/);
  assert.match(html, /nothing has been uploaded/);
  assert.ok(html.includes(LEADERBOARD_CAVEAT));
  assert.match(html, /<th>N<\/th>/);
  assert.doesNotMatch(html, /https?:\/\/|<script src|<link rel/);
  // The dogfood pass-rate scale: (8 + 0.5·2) / 11 ≈ 82%.
  assert.match(html, />82%</);
});

test('a hostile model id is rejected at the VALUE boundary — it never even reaches the page', () => {
  // Stronger than HTML escaping: MODEL_RE forbids <>&" entirely, so the merge
  // drops the snapshot and the page has nothing to (mis)render. esc() remains
  // as defense-in-depth for the generatedAt/banner strings.
  const cells = mergeShareSnapshots([snap('local', '<img src=x onerror=alert(1)>')], { localOnly: true });
  assert.deepEqual(cells, []);
  const html = renderLeaderboardPage(cells, { mode: 'local', generatedAtIso: AT });
  assert.doesNotMatch(html, /onerror/);
  assert.match(html, /No reviewed offloads recorded yet/);
});

test('published mode ENFORCES suppression internally — a thin cell can never render under the banner', () => {
  const one = mergeShareSnapshots([snap('c1', 'gpt-5.5')], { localOnly: true });
  // Feeding an unsuppressed N=1 cell into published mode must NOT render it:
  // the page applies publishLeaderboard itself, so the banner can never lie.
  const html = renderLeaderboardPage(one, { mode: 'published', generatedAtIso: AT });
  assert.match(html, /PUBLISHED VIEW/);
  assert.match(html, new RegExp(`≥ ${MIN_USERS} distinct contributors`));
  assert.match(html, /No cell clears the publication bar yet/);
  assert.doesNotMatch(html, /gpt-5\.5/); // the thin cell is absent
});

test('local empty state: invites routing rather than implying suppression', () => {
  const html = renderLeaderboardPage([], { mode: 'local', generatedAtIso: AT });
  assert.match(html, /No reviewed offloads recorded yet/);
  assert.doesNotMatch(html, /publication bar/);
});
