/**
 * TokenMaxed session summary — pure builder + renderer (no host I/O, no runtime
 * core import: every `@tokenmaxed/core` symbol here is `import type` only, fully
 * erased at build time). The core aggregate functions and the manager selector
 * are INJECTED, so callers (the router_summary tool, the /tokenmaxed:summary
 * skill, and the SessionStart hook) share one source of truth without breaking
 * tools.ts's no-runtime-import test shape.
 *
 * Honest-accounting invariant: the headline is metered API dollars AVOIDED
 * (finance-grade). The all-frontier figure is never the headline. The feel-good
 * proxy is the token-weighted share of routed tokens that incurred $0 metered
 * spend — computed only from existing content-free ledger primitives.
 */

import type { LedgerEvent, LedgerSummary, Lane, Policy, TokenStats } from '@tokenmaxed/core';
import type { ManagerSelectPort } from './manager-select.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Core aggregate functions, injected so this module needs no runtime core import. */
export interface SummaryCorePort {
  summarize: (events: readonly LedgerEvent[]) => LedgerSummary;
  tokenStats: (events: readonly LedgerEvent[]) => TokenStats;
  filterEventsSince: <E extends { ts: string }>(events: readonly E[], sinceIso?: string) => E[];
}

/** Everything the builder needs; all I/O is resolved by the caller. */
export interface SummaryInput {
  events: readonly LedgerEvent[];
  /** The FULL configured lane set (not category-filtered — the summary is global). */
  lanes: readonly Lane[];
  policy: Policy;
  /** Ids of lanes that can run now (from the availability probe). */
  availableLaneIds: readonly string[];
  gateReady: boolean;
  /** Routing enabled for this project (the persisted /tokenmaxed:off toggle). */
  enabled: boolean;
  /** Wall-clock ms (injected for deterministic windows). */
  now: number;
  core: SummaryCorePort;
  /** The real selectManagerLane, injected (keeps this module runtime-pure). */
  selectManager: ManagerSelectPort;
  /**
   * Stale-model findings (MODEL-FRESHNESS), computed by the caller CACHE-ONLY (no
   * egress on the summary path). Each names a lane on a stale pinned/resolved model
   * and the newer one available. Empty when nothing is cached or nothing is stale.
   */
  staleness: readonly LaneStaleness[];
  /**
   * SETUP-1 B: lane-review status vs the configured set (read-only — the summary only
   * HINTS, never marks seen; only /tokenmaxed:setup records a review). Default
   * 'current' ⇒ no hint.
   */
  laneReview?: 'first-review' | 'changed' | 'current';
}

/** A stale-model finding for one lane (structural subset of a freshness warning). */
export interface LaneStaleness {
  laneId: string;
  newest: string;
  newestPriced: boolean;
}

export interface SummaryWindow {
  label: '24h' | '7d' | 'lifetime';
  tokens: number;
  /** Metered API dollars avoided in the window (finance-grade). */
  meteredAvoided: number;
  /** Count of routed task events in the window. */
  offloads: number;
}

export interface LaneSummary {
  id: string;
  kind: Lane['kind'];
  model: string;
  trustMode: Lane['trust_mode'];
  /** True for the lane the review path would actually use right now. */
  isActiveReviewer: boolean;
  available: boolean;
  /** Set when a newer model is available for this lane's family (cache-derived). */
  stale?: { newest: string; newestPriced: boolean };
}

export interface SummaryData {
  enabled: boolean;
  /** Headline: lifetime + 7d metered $ avoided. */
  meteredAvoidedLifetime: number;
  meteredAvoided7d: number;
  /** Token-weighted share (0..1) of routed tokens that cost $0 metered. */
  zeroMeteredShare: number;
  windows: SummaryWindow[];
  lanes: LaneSummary[];
  activeReviewerId?: string;
  /** SETUP-1 B: lane-review status (drives a read-only "run /tokenmaxed:setup" hint). */
  laneReview?: 'first-review' | 'changed' | 'current';
  /** True when there are no routed task events yet (new user). */
  empty: boolean;
}

/** Build the structured summary. Pure over its injected deps. */
export function buildSummaryData(input: SummaryInput): SummaryData {
  const { events, lanes, policy, availableLaneIds, gateReady, enabled, now, core, selectManager } = input;
  const availableSet = new Set(availableLaneIds);

  const windowFor = (label: SummaryWindow['label'], sinceIso?: string): SummaryWindow => {
    const evs = core.filterEventsSince(events, sinceIso);
    const summary = core.summarize(evs);
    return {
      label,
      tokens: core.tokenStats(evs).total.total,
      meteredAvoided: summary.savings.metered_avoided,
      offloads: summary.events,
    };
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  const windows: SummaryWindow[] = [
    windowFor('24h', iso(now - DAY_MS)),
    windowFor('7d', iso(now - 7 * DAY_MS)),
    windowFor('lifetime'),
  ];
  const lifetime = windows[2]!;
  const week = windows[1]!;

  // Token-weighted $0-metered share over ALL task events (lifetime). Reading
  // event fields directly (no core import); guard the discriminant inline.
  let zeroTok = 0;
  let allTok = 0;
  for (const e of events) {
    if (e.event_type !== 'task') continue;
    const tok = e.tokens_in + e.tokens_out;
    allTok += tok;
    if (e.metered_spent === 0) zeroTok += tok;
  }
  const zeroMeteredShare = allTok > 0 ? zeroTok / allTok : 1;

  const reviewer = selectManager(lanes, policy, gateReady, availableSet);
  const staleByLane = new Map(input.staleness.map((s) => [s.laneId, s]));
  const laneSummaries: LaneSummary[] = lanes.map((l) => {
    const s = staleByLane.get(l.id);
    return {
      id: l.id,
      kind: l.kind,
      model: l.model,
      trustMode: l.trust_mode,
      isActiveReviewer: !!reviewer && l.id === reviewer.id,
      available: !!l.native || availableSet.has(l.id),
      ...(s ? { stale: { newest: s.newest, newestPriced: s.newestPriced } } : {}),
    };
  });

  return {
    enabled,
    meteredAvoidedLifetime: lifetime.meteredAvoided,
    meteredAvoided7d: week.meteredAvoided,
    zeroMeteredShare,
    windows,
    lanes: laneSummaries,
    ...(reviewer ? { activeReviewerId: reviewer.id } : {}),
    ...(input.laneReview ? { laneReview: input.laneReview } : {}),
    empty: lifetime.offloads === 0,
  };
}

// --- rendering (dependency-free: pure data → string) ---------------------------

const usd = (n: number): string => `$${n.toFixed(2)}`;
const pct = (share: number): string => `${Math.round(share * 100)}%`;
/** Compact token count, e.g. 1240000 → "1,240k". */
function tok(n: number): string {
  const k = Math.round(n / 1000);
  return `${k.toLocaleString('en-US')}k`;
}

/** Render the banner. Dependency-free; safe to call from any caller. */
export function formatSummaryBanner(data: SummaryData): string {
  if (!data.enabled) {
    return '⏸  TokenMaxed routing is OFF for this project — run /tokenmaxed:on to re-enable.';
  }
  const lines: string[] = [];
  if (data.empty) {
    lines.push('🟢 TokenMaxed — ready. No routed work yet; your savings will show here.');
  } else {
    lines.push('🟢 TokenMaxed — maximizing your flat-rate capacity');
    lines.push(
      `   Saved ${usd(data.meteredAvoidedLifetime)} in metered API spend (lifetime) · ` +
        `${usd(data.meteredAvoided7d)} last 7d`,
    );
    lines.push(`   ${pct(data.zeroMeteredShare)} of routed tokens cost $0 metered`);
    lines.push('');
    for (const w of data.windows) {
      lines.push(
        `   ${w.label.padEnd(9)}${tok(w.tokens).padStart(9)} tok routed · ` +
          `${usd(w.meteredAvoided)} metered avoided · ${w.offloads} offloads`,
      );
    }
  }
  lines.push('');
  if (data.lanes.length > 0) {
    const laneStr = data.lanes
      .map((l) => {
        const role = l.isActiveReviewer ? 'reviewer' : l.trustMode;
        return `${l.id} (${role})${l.available ? '' : ' ⚠ offline'}${l.stale ? ' ⚠ stale' : ''}`;
      })
      .join(' · ');
    lines.push(`   Lanes: ${laneStr}`);
  } else {
    lines.push('   No lanes configured yet — run /tokenmaxed:setup');
  }
  // SETUP-1 B hint (read-only — only /tokenmaxed:setup records a review). Only when
  // lanes exist (an empty config already nudges to run setup above).
  if (data.lanes.length > 0 && data.laneReview === 'changed') {
    lines.push('   ⚠ your lanes changed since you last reviewed them — run /tokenmaxed:setup to review');
  } else if (data.lanes.length > 0 && data.laneReview === 'first-review') {
    lines.push('   ℹ run /tokenmaxed:setup to review what each lane may see/do');
  }
  // Spell out each stale lane (cache-derived; refreshed by /tokenmaxed:status).
  const stale = data.lanes.filter((l) => l.stale);
  for (const l of stale) {
    lines.push(
      l.stale!.newestPriced
        ? `   ⚠ ${l.id} on ${l.model} — newer available: ${l.stale!.newest} (set model: <family>@latest, or pin it)`
        : `   ⚠ ${l.id} on ${l.model} — newer ${l.stale!.newest} exists but isn't priced yet`,
    );
  }
  lines.push('   /tokenmaxed:summary anytime · /tokenmaxed:why <category> to preview · /tokenmaxed:savings for detail');
  return lines.join('\n');
}

/** Pointer appended whenever {@link clampBanner} trims content. */
const CLAMP_POINTER = '   … run /tokenmaxed:summary for full detail';

/**
 * Clamp a rendered banner for the SessionStart `systemMessage` surface — a UX
 * tidiness guard, NOT a workaround for a host limit (the Claude Code host imposes
 * no hard cap; `systemMessageChars` is a telemetry counter only). Keeps the
 * headline, the three window lines, and the `Lanes:` line; drops the lowest-value
 * trailing detail FIRST (the tips line, then per-stale-lane spell-outs, then the
 * setup hint) and appends a pointer to the full summary when it trims. As a final
 * postcondition it ellipsizes the longest remaining line (in practice the single,
 * possibly long `Lanes:` line) so the result ALWAYS fits the budget while
 * preserving that line's presence. Idempotent when already within budget.
 *
 * Postcondition: `out.length <= maxChars` for every input. Both budgets are
 * normalized to NON-NEGATIVE INTEGERS (`Math.max(0, Math.floor(…))`), so negative,
 * zero, and fractional budgets are all well-defined (a budget < 1 ⇒ 0 ⇒ empty
 * output), and the inequality holds against the normalized budget.
 *
 * Pure string→string so one clamped source can feed BOTH the visible
 * `systemMessage` and the model-context `additionalContext` (kept byte-identical).
 */
export function clampBanner(banner: string, opts: { maxLines?: number; maxChars?: number } = {}): string {
  // Normalize to non-negative integers so the postcondition is exact for any real
  // input (negative/fractional included): a budget < 1 floors to 0 ⇒ empty output.
  const maxLines = Math.max(0, Math.floor(opts.maxLines ?? 12));
  const maxChars = Math.max(0, Math.floor(opts.maxChars ?? 1500));
  if (maxChars === 0) return '';
  const fits = (s: string, ml: number, mc: number): boolean => s.split('\n').length <= ml && s.length <= mc;

  if (fits(banner, maxLines, maxChars)) return banner;

  // We are going to trim ⇒ reserve room for the pointer line in the effective budget.
  const effLines = Math.max(1, maxLines - 1);
  const effChars = Math.max(1, maxChars - (CLAMP_POINTER.length + 1));

  // Drop-priority: higher = dropped sooner. 0 = required (never dropped by rank).
  const dropRank = (line: string): number => {
    if (line.includes('/tokenmaxed:summary anytime')) return 3; // the tips line
    if (/^\s*⚠ .*— newer/.test(line)) return 2; // per-stale-lane spell-outs
    if (line.includes('/tokenmaxed:setup')) return 1; // setup review hint(s)
    return 0; // headline, window lines, Lanes line, blanks
  };

  let lines = banner.split('\n');
  const removed = new Set<number>();
  // Order droppable lines rank 3→1, bottom-most first within a rank.
  const order = lines
    .map((line, i) => ({ i, rank: dropRank(line) }))
    .filter((x) => x.rank > 0)
    .sort((a, b) => b.rank - a.rank || b.i - a.i);
  for (const { i } of order) {
    if (fits(lines.filter((_, j) => !removed.has(j)).join('\n'), effLines, effChars)) break;
    removed.add(i);
  }
  lines = lines.filter((_, j) => !removed.has(j));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop(); // tidy trailing blanks
  lines.push(CLAMP_POINTER);

  // If STILL over maxChars (e.g. one very long Lanes line), ellipsize the longest
  // line so the result fits while keeping every line's presence — the common case
  // (a big lane set) lands here with the skeleton intact.
  let out = lines.join('\n');
  if (out.length > maxChars) {
    let idx = 0;
    for (let k = 1; k < lines.length; k++) if (lines[k]!.length > lines[idx]!.length) idx = k;
    const overBy = out.length - maxChars;
    const target = Math.max(0, lines[idx]!.length - overBy - 1); // -1 for the ellipsis char
    lines[idx] = `${lines[idx]!.slice(0, target)}…`;
    out = lines.join('\n');
  }
  // Hard postcondition backstop: GUARANTEE out.length <= maxChars even when the
  // required skeleton alone exceeds it (a pathologically tiny budget). Line-aware
  // ellipsis is preferred above; this is the absolute floor that can never be passed.
  if (out.length > maxChars) out = `${out.slice(0, Math.max(0, maxChars - 1))}…`;
  return out;
}
