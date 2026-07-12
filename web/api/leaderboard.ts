/**
 * D (hosted, launch-ready — NOT DEPLOYED) — the published leaderboard page.
 *
 * GET → text/html rendered by the SAME renderLeaderboardPage the local CLI
 * uses, in 'published' mode — which enforces k-anonymity suppression
 * INTERNALLY (cells with < 5 contributors or < 10 verdicts are withheld no
 * matter what this handler passes in). Snapshots merge with the SAME
 * mergeShareSnapshots + trusted catalog as submission — one boundary, no
 * drift. Cached briefly at the edge; this page is an aggregate, not a feed.
 */

import { list } from '@vercel/blob';
import { mergeShareSnapshots } from '@tokenmaxed/core';
import { renderLeaderboardPage } from '@tokenmaxed/cli';

import { KNOWN_MODELS } from '../lib/catalog.js';

export async function GET(): Promise<Response> {
  const raws: unknown[] = [];
  try {
    const { blobs } = await list({ prefix: 'snapshots/', limit: 1000 });
    const bodies = await Promise.all(
      blobs.map(async (b) => {
        try {
          return (await (await fetch(b.url)).json()) as unknown;
        } catch {
          return undefined; // an unreadable blob never breaks the page
        }
      }),
    );
    for (const body of bodies) if (body !== undefined) raws.push(body);
  } catch {
    /* listing failed ⇒ empty page (still honest: published mode shows nothing) */
  }
  // mergeShareSnapshots validates every snapshot itself (never throws on bad input).
  const cells = mergeShareSnapshots(raws, { knownModels: KNOWN_MODELS });
  const html = renderLeaderboardPage(cells, { mode: 'published' });
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 's-maxage=300, stale-while-revalidate=600' },
  });
}
