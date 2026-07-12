/**
 * Library surface of @tokenmaxed/cli — what the hosted leaderboard (web/)
 * imports: the page renderer (published-mode suppression lives inside it) and
 * the share-flow primitives. The bin entry stays cli.ts.
 */

export { renderLeaderboardPage } from './leaderboard-page.ts';
export type { LeaderboardPageOptions } from './leaderboard-page.ts';
export {
  buildSharePayload,
  CONSENT_COPY,
  formatSharePreview,
  isoWeekId,
  isoWeekStartMs,
  nextRevision,
  readOrCreateContributor,
  recordRevision,
  rotateContributor,
  uploadSnapshot,
} from './share.ts';
export type { ContributorState, ContributorStore, FetchLike, SharePayload, UploadResult } from './share.ts';
