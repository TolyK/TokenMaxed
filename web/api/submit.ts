/**
 * D (hosted, launch-ready — NOT DEPLOYED) — the snapshot submission endpoint.
 *
 * POST body = one canonical ShareSnapshot (the EXACT bytes `tokenmaxed share
 * --yes` sends). The server re-runs the SAME hardened validation the client
 * used (core/leaderboard-share.ts: structural UUIDv4/ISO-week provenance,
 * enum membership, non-negative safe integers, canonical rows, bounded count)
 * PLUS the trusted model catalog (data/known-models.json — regenerate from
 * config/prices.seed.json at deploy) and rejects the 'local' sentinel.
 *
 * Storage: one Vercel Blob per (window, contributor) at
 * snapshots/<window>/<contributor>.json — replace-by-snapshot: the stored and
 * incoming snapshots go through the SAME mergeShareSnapshots rule (highest
 * revision wins; equal-revision ties resolve by canonical serialization), so
 * the wire and storage semantics can never drift.
 */

import { createHmac } from 'node:crypto';

import { list, put } from '@vercel/blob';
import { validateShareSnapshot, serializeShareSnapshot } from '@tokenmaxed/core';
import type { ShareSnapshot } from '@tokenmaxed/core';

import { KNOWN_MODELS } from '../lib/catalog.js';

const MAX_BODY_BYTES = 256 * 1024; // a legitimate weekly snapshot is a few KB

export async function POST(request: Request): Promise<Response> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return reject(400, 'unreadable body');
  }
  if (raw.length > MAX_BODY_BYTES) return reject(413, 'snapshot too large');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject(400, 'not JSON');
  }

  const result = validateShareSnapshot(parsed, { knownModels: KNOWN_MODELS });
  if (!result.valid) return reject(422, result.reason);
  const incoming = result.snapshot;
  // The wire NEVER accepts the on-machine sentinel (the client serializer
  // refuses to emit it; the server refuses independently).
  if (incoming.contributor_id === 'local' || incoming.window_id === 'local') {
    return reject(422, 'local sentinel is not uploadable');
  }

  // CONSENT LAW: the raw contributor UUID is NEVER stored or published — not
  // in the blob pathname, not in the body. It is pseudonymized with a keyed
  // HMAC into a SHAPED UUIDv4 (stable per contributor while the secret is
  // stable, so dedup/replace and the merge's distinct-users count still work,
  // and every stored snapshot still passes the same structural validation).
  const secret = process.env.SHARE_PSEUDONYM_SECRET;
  if (!secret) return reject(503, 'server misconfigured: SHARE_PSEUDONYM_SECRET is not set');
  const pseudo = pseudonymize(incoming.contributor_id, secret);
  const stored_as: ShareSnapshot = { ...incoming, contributor_id: pseudo };

  const key = `snapshots/${incoming.window_id}/${pseudo}.json`;
  // Replace-by-snapshot: apply the SAME revision rule the merge uses. A lower
  // or losing-tie revision is acknowledged but not stored (idempotent client
  // retries stay simple).
  // NOTE (accepted v1 limitation): read-then-put is not atomic. Submissions
  // for one (window, contributor) come from ONE machine in practice; the worst
  // concurrent-race outcome is an older revision persisting until that
  // contributor's next upload replaces it. No cross-contributor effect.
  const stored = await readExisting(key);
  const winner = pickWinner(stored, stored_as);
  if (winner !== stored) {
    await put(key, serializeShareSnapshot(winner, { knownModels: KNOWN_MODELS }), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  }
  return new Response(JSON.stringify({ ok: true, window: incoming.window_id, revision: winner.revision }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function readExisting(key: string): Promise<ShareSnapshot | undefined> {
  try {
    const { blobs } = await list({ prefix: key, limit: 1 });
    const hit = blobs.find((b) => b.pathname === key);
    if (!hit) return undefined;
    const res = await fetch(hit.url);
    const validated = validateShareSnapshot(await res.json(), { knownModels: KNOWN_MODELS });
    return validated.valid ? validated.snapshot : undefined; // corrupt stored blob ⇒ replace
  } catch {
    return undefined; // unreadable ⇒ treat as absent (the incoming snapshot wins)
  }
}

/** Highest revision wins; equal revisions tie-break on canonical serialization (the merge rule). */
function pickWinner(stored: ShareSnapshot | undefined, incoming: ShareSnapshot): ShareSnapshot {
  if (!stored) return incoming;
  if (incoming.revision !== stored.revision) return incoming.revision > stored.revision ? incoming : stored;
  const a = serializeShareSnapshot(stored, { knownModels: KNOWN_MODELS });
  const b = serializeShareSnapshot(incoming, { knownModels: KNOWN_MODELS });
  return b > a ? incoming : stored;
}

/** Keyed HMAC → a SHAPED UUIDv4 (version/variant nibbles forced) — a stable
 * pseudonym that satisfies the same structural validation as a real id. */
function pseudonymize(contributorId: string, secret: string): string {
  const hex = createHmac('sha256', secret).update(contributorId).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function reject(status: number, reason: string): Response {
  return new Response(JSON.stringify({ ok: false, reason }), { status, headers: { 'content-type': 'application/json' } });
}
