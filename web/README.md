# TokenMaxed hosted leaderboard — launch runbook

**Status: LAUNCH-READY, NOT DEPLOYED.** This directory holds the Vercel
functions + published page for the community leaderboard. Nothing here runs
until the deploy steps below happen at site launch; until then the client's
`tokenmaxed share --yes` refuses (no `TOKENMAXED_SHARE_URL` is announced).

## What it serves

- `POST /api/submit` — accepts ONE canonical ShareSnapshot (the exact bytes
  `tokenmaxed share --yes` sends). Validation is the same hardened boundary as
  the client (`@tokenmaxed/core` `validateShareSnapshot`) plus the trusted
  model catalog; storage is one Blob per (window, contributor) with
  replace-by-revision semantics identical to the merge rule.
- `GET /api/leaderboard` — the published page, rendered by the same
  `renderLeaderboardPage` as the local CLI in `published` mode, which enforces
  the k-anonymity suppression internally (≥ 5 contributors AND ≥ 10 verdicts
  per shown cell).

## Launch checklist

1. **Consent sign-off** — the operator-approved consent copy lives in
   `packages/cli/src/share.ts` (`CONSENT_COPY`); re-read it before launch.
2. Regenerate the catalog: `node web/generate-catalog.mjs` (reproducible; the
   repo test suite pins the committed catalog as a superset of the price
   table's ids).
3. Build the local packages FIRST — `web`'s `file:` deps symlink into the
   repo, and the functions import each package's `dist`:
   `npm install && npm run build` at the REPO ROOT, then `cd web && npm
   install`. (web/ is deliberately NOT an npm workspace, so repo CI never
   depends on Vercel packages.)
4. `vercel link` (new project, Root Directory = `web`, and enable "Include
   source files outside of the Root Directory" — the functions reach
   `../packages/*` through the `file:` links; `vercel.json`'s installCommand
   runs the root build). Provision a **Blob store** and pull
   `BLOB_READ_WRITE_TOKEN` into the project.
5. Set **`SHARE_PSEUDONYM_SECRET`** (e.g. `openssl rand -hex 32`) — submissions
   are refused without it. The raw contributor UUID is never stored: it is
   HMAC-pseudonymized into a shaped UUID before the blob is written, so
   public blob URLs can never leak it. KEEP THE SECRET STABLE — rotating it
   forks every contributor's stored identity (old snapshots strand under the
   old pseudonyms until their windows age out).
6. `vercel deploy --prod`.
7. Verify: `curl -X POST <url>/api/submit` with a fixture snapshot (422 for a
   bad one, 200 for a good one); `GET <url>/api/leaderboard` shows the
   published banner and (initially) an empty table — cells appear only once
   ≥ 5 contributors × ≥ 10 verdicts exist. That's correct, not a bug.
8. Announce `TOKENMAXED_SHARE_URL=<url>/api/submit` in the README so
   `tokenmaxed share --yes` can reach it.

## Design invariants (do not relax at launch)

- The server NEVER accepts the `local` sentinel, an unknown model, or a
  non-UUIDv4 contributor / non-ISO-week window (structural provenance).
- Suppression lives INSIDE the page renderer's published mode — no handler
  can render a thin cell.
- One boundary: client serializer, server validator, storage replace rule,
  and merge all come from `@tokenmaxed/core`'s leaderboard-share module.

## Accepted v1 limitations (documented, not hidden)

- **The MIN_USERS threshold resists accidents, not adversaries.** `--rotate-id`
  mints fresh identities, so one determined person could inflate a cell's
  distinct-contributor count by rotating and re-uploading. v1 accepts this
  (the leaderboard is a community signal, not a security boundary); server-side
  rate limiting / attestation is the escalation path if it's ever abused.
- **Replace-by-revision is read-then-put, not atomic.** Submissions for one
  (window, contributor) come from one machine in practice; the worst race
  outcome is an older revision persisting until the next upload. No
  cross-contributor effect.
