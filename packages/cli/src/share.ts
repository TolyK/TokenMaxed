/**
 * D (hosted step, launch-ready) — the OPT-IN share flow: contributor identity,
 * consent + exact-payload inspection, and the upload client. PURE over
 * injected I/O (tests fake fs/fetch); cli.ts wires the real impls.
 *
 * Consent law (approved product design): nothing EVER uploads without an
 * explicit `--yes` on a command whose default behavior is to SHOW the exact
 * serialized payload and send nothing. The payload is the hardened
 * ShareSnapshot wire format (core/leaderboard-share.ts): per-(model, category,
 * difficulty) verdict counts + token totals for ONE ISO week — ids, enums and
 * integers only; never code, prompts, repo names, paths, timestamps, or lane
 * configuration. The contributor id is a rotatable random UUID (dedup only,
 * never published).
 *
 * NOT YET LIVE: the hosted endpoint deploys at site launch (web/ holds the
 * launch-ready functions). Until TOKENMAXED_SHARE_URL is set, `--yes` fails
 * with a clear "not launched yet" message — the flow is fully testable
 * without any network.
 */

import type { ShareSnapshot } from '@tokenmaxed/core';
import { serializeShareSnapshot, shareSnapshotFromRows } from '@tokenmaxed/core';
import type { LeaderboardRow } from '@tokenmaxed/core';

// --- consent copy (operator sign-off at launch; the flow is inert until then) ---

/**
 * The consent text shown with every payload preview (operator-approved framing
 * 2026-07-12: lead with "we never see your code or your prompts — just the
 * success rate of the model, with the task's difficulty and category").
 * Wording changes here never change WHAT is sent (the serializer's allowlists
 * do that).
 */
export const CONSENT_COPY = `We never see your code or your prompts.
Sharing sends exactly one thing: the SUCCESS RATE of each model you routed
work to, broken down by the task's category and difficulty — the aggregate
table below, and nothing else.

  • Sent: per (model, category, difficulty) review-verdict counts (pass /
    needs-rework / fail) and token totals from YOUR routed work, for one ISO
    week. Ids, enums, and integers only.
  • Never sent: code, prompts, file paths, repo or project names, lane
    configuration, timestamps finer than the ISO week, or anything you typed.
  • Your contributor id is a random UUID used only to de-duplicate re-uploads.
    It is never published, and \`tokenmaxed share --rotate-id\` mints a fresh
    one at any time (past uploads stay under the old id).
  • Published cells are k-anonymous: the public page only shows cells with
    ≥ 5 distinct contributors and ≥ 10 verdicts — thinner cells are withheld.
  • Contributing keeps the community data feed free for you (the flywheel:
    contributors get the feed; non-contributors will pay for it).
  • One-shot: this command uploads once. There is no background sharing, ever.`;

// --- contributor identity ---------------------------------------------------------

/** Persisted at ~/.tokenmaxed/contributor.json (created at first opt-in). */
export interface ContributorState {
  contributor_id: string;
  created: string;
  /** Monotonic revision per window id — the server replaces lower revisions. */
  revisions: Record<string, number>;
}

/** Injected persistence (cli.ts supplies real fs; tests fake it). */
export interface ContributorStore {
  read: () => string | undefined;
  write: (text: string) => void;
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Read the contributor state, creating (and persisting) it on absence/corruption. */
export function readOrCreateContributor(store: ContributorStore, newUuid: () => string, nowIso: () => string): ContributorState {
  const raw = store.read();
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as Partial<ContributorState>;
      if (typeof parsed.contributor_id === 'string' && UUID_V4_RE.test(parsed.contributor_id)) {
        return {
          contributor_id: parsed.contributor_id,
          created: typeof parsed.created === 'string' ? parsed.created : nowIso(),
          revisions: parsed.revisions && typeof parsed.revisions === 'object' ? { ...parsed.revisions } : {},
        };
      }
    } catch {
      /* corrupt ⇒ recreate below (a fresh id is the safe failure mode) */
    }
  }
  const state: ContributorState = { contributor_id: newUuid(), created: nowIso(), revisions: {} };
  store.write(JSON.stringify(state, null, 2));
  return state;
}

/**
 * Mint a fresh identity. Past uploads stay under the old id (documented).
 * HONESTY NOTE: rotation means the published MIN_USERS threshold resists
 * accidental thinness, not adversarial inflation — a determined person could
 * rotate + re-upload to look like several contributors (accepted v1
 * limitation, documented in web/README.md).
 */
export function rotateContributor(store: ContributorStore, newUuid: () => string, nowIso: () => string): ContributorState {
  const state: ContributorState = { contributor_id: newUuid(), created: nowIso(), revisions: {} };
  store.write(JSON.stringify(state, null, 2));
  return state;
}

/** The revision the NEXT upload for `windowId` should carry (monotonic from 1). */
export function nextRevision(state: ContributorState, windowId: string): number {
  return (state.revisions[windowId] ?? 0) + 1;
}

/** Persist a successful upload's revision so re-uploads replace, never fork. */
export function recordRevision(store: ContributorStore, state: ContributorState, windowId: string, revision: number): ContributorState {
  const next: ContributorState = { ...state, revisions: { ...state.revisions, [windowId]: revision } };
  store.write(JSON.stringify(next, null, 2));
  return next;
}

// --- ISO week window ----------------------------------------------------------------

/** The ISO-8601 week id (e.g. "2026-W28") for a UTC timestamp. */
export function isoWeekId(nowMs: number): string {
  const d = new Date(nowMs);
  // ISO week: Thursday of the current week determines the week-year.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const week1 = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target.getTime() - week1.getTime()) / 86_400_000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** UTC start of the ISO week containing `nowMs` (Monday 00:00Z), for event filtering. */
export function isoWeekStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

// --- payload build + preview ---------------------------------------------------------

export interface SharePayload {
  snapshot: ShareSnapshot;
  /** The EXACT bytes an upload would send (canonical serialization). */
  serialized: string;
  windowId: string;
  revision: number;
}

/**
 * Build the upload payload from this week's leaderboard rows. Throws (via the
 * serializer) if any model falls outside the trusted catalog — the same
 * membership rule the server enforces.
 */
export function buildSharePayload(
  rows: readonly LeaderboardRow[],
  state: ContributorState,
  nowMs: number,
  knownModels: ReadonlySet<string>,
): SharePayload {
  const windowId = isoWeekId(nowMs);
  const revision = nextRevision(state, windowId);
  const snapshot = shareSnapshotFromRows(rows, { contributor_id: state.contributor_id, window_id: windowId, revision });
  const serialized = serializeShareSnapshot(snapshot, { knownModels });
  return { snapshot, serialized, windowId, revision };
}

/** The human preview: consent copy + a cell summary + the EXACT payload bytes. */
export function formatSharePreview(payload: SharePayload, opts: { endpoint?: string; catalogNote?: string }): string {
  const { snapshot } = payload;
  const cells = snapshot.rows.length;
  const verdicts = snapshot.rows.reduce((n, r) => n + r.pass + r.needs_rework + r.fail, 0);
  const models = new Set(snapshot.rows.map((r) => r.model)).size;
  return [
    'TokenMaxed — share this week\'s anonymized aggregates (OPT-IN)',
    '',
    CONSENT_COPY,
    '',
    `Window: ${payload.windowId} · revision ${payload.revision} · contributor ${snapshot.contributor_id}`,
    `Cells: ${cells} (${models} model(s), ${verdicts} verdict(s))`,
    `Endpoint: ${opts.endpoint ?? 'NOT CONFIGURED — the hosted leaderboard has not launched yet'}`,
    '',
    'EXACT payload (what --yes would send — nothing more):',
    payload.serialized,
    '',
    ...(opts.catalogNote ? [opts.catalogNote, ''] : []),
    opts.endpoint
      ? 'Nothing was sent. --yes rebuilds and uploads the CURRENT week\'s payload (shown above as of now; new events or an ISO-week rollover change it accordingly).'
      : 'Nothing was sent (and --yes would refuse until TOKENMAXED_SHARE_URL is set at launch).',
  ].join('\n');
}

// --- upload client ---------------------------------------------------------------------

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export type UploadResult = { ok: true; status: number } | { ok: false; status?: number; message: string };

/** POST the exact serialized snapshot. Never throws — the CLI prints the result. */
export async function uploadSnapshot(fetchImpl: FetchLike, url: string, serialized: string): Promise<UploadResult> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: serialized,
    });
    if (res.ok) return { ok: true, status: res.status };
    let message = `upload rejected (HTTP ${res.status})`;
    try {
      const body = await res.text();
      if (body.trim()) message += `: ${body.slice(0, 300)}`;
    } catch {
      /* body unavailable */
    }
    return { ok: false, status: res.status, message };
  } catch (e) {
    return { ok: false, message: `upload failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
