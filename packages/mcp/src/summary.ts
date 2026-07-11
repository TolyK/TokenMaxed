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

import type { LedgerEvent, LedgerSummary, Lane, Policy, TokenStats, WindowLevel } from '@tokenmaxed/core';
import type { ManagerSelectPort } from './manager-select.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mirrors {@link FIVE_HOUR_MS} in core — kept local so this module stays runtime-core-free. */
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

/** B: humanize a window length for labels ("5h", "2h", "90m"). */
export function fmtWindow(ms: number): string {
  if (ms >= 3_600_000) {
    const hours = ms / 3_600_000;
    const rounded = Math.round(hours * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded}h`;
  }
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/** B3: humanize a projected duration — relative, coarse, never a calendar time. */
export function fmtEta(ms: number): string {
  const minutes = ms / 60_000;
  // Already at/over the cap: say so honestly rather than "~1m away".
  if (minutes < 0.75) return 'now';
  if (minutes < 90) return `~${Math.max(1, Math.round(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 36) return `~${Math.round(hours)}h`;
  return `~${Math.round(hours / 24)}d`;
}

/** Core aggregate functions, injected so this module needs no runtime core import. */
export interface SummaryCorePort {
  summarize: (events: readonly LedgerEvent[]) => LedgerSummary;
  tokenStats: (events: readonly LedgerEvent[]) => TokenStats;
  filterEventsSince: <E extends { ts: string }>(events: readonly E[], sinceIso?: string) => E[];
  /** Rolling-window request count (injected — core stays out of this module at runtime). */
  requestsInWindow: (timestampsMs: readonly number[], now: number, windowMs?: number) => number;
  windowUsedFraction: (count: number, limit: number) => number;
  windowLevel: (usedFraction: number) => WindowLevel;
  /**
   * B3: earliest projected depletion across a lane's configured quota axes
   * (routed-share only; omit-first evidence gates). Optional — absent ⇒ no
   * forecasts anywhere in the summary.
   */
  laneDepletionForecast?: (
    events: readonly LedgerEvent[],
    lane: Lane,
    now: number,
  ) => { etaMs: number; confidence: 'low' | 'moderate' } | undefined;
  /**
   * B: full quota state (all axes) so weekly-only caps also gate forecasts and
   * render alerts. Optional — absent ⇒ window-axis behavior only.
   */
  laneQuotaState?: (
    events: readonly LedgerEvent[],
    lane: Lane,
    now: number,
  ) => {
    weekRequests?: { count: number; limit: number; level: WindowLevel };
    weekTokens?: { count: number; limit: number; level: WindowLevel };
  };
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
  /**
   * Host CLI per-model token usage (real, transcript-derived) to FOLD into per-lane
   * counts so the lanes show the main-session model's own usage, not just routed
   * work. Keyed by resolved model id; each model's usage is attributed to AT MOST
   * one lane (the first whose model matches). Optional — absent ⇒ routed-only counts.
   */
  cliUsageByModel?: Record<string, { in: number; out: number }>;
  meteredKeyWarning?: boolean;
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
  /** Count of `native` breadcrumbs in the window — delegates that degraded to the host. */
  nativeFallbacks: number;
}

export interface LaneSummary {
  id: string;
  kind: Lane['kind'];
  model: string;
  trustMode: Lane['trust_mode'];
  /** Provenance/vendor, used to render a friendly name (anthropic ⇒ "Claude"). */
  provenance: Lane['provenance'];
  /** Lifetime tokens routed to THIS lane (from tokenStats().byLane); 0 if none yet. */
  tokensRouted: number;
  /** Routed task events in the lane's trailing window (ledger-only; not total subscription usage). */
  requestsIn5h: number;
  /** B: hours of a non-default window (lane window_ms override); absent ⇒ the 5h default. */
  windowHours?: number;
  /** B3: projected ms until a quota axis depletes at the current ROUTED pace (moderate confidence only). */
  forecastEtaMs?: number;
  /** B3: true ⇒ a projection exists but only at low confidence (render no time). */
  forecastLow?: boolean;
  /** B: worst weekly-axis level, when a weekly cap is configured and warn/critical. */
  weekLevel?: 'warn' | 'critical';
  /** B: compact weekly-axis detail ("7d 8/10 req · 7d 10,500/15,000 tok"). */
  weekDetail?: string;
  /** Configured per-5h request limit, when set on the lane. */
  requestsPerWindow?: number;
  /** Quota level vs {@link requestsPerWindow}, when configured. */
  requestWindowLevel?: WindowLevel;
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
  meteredKeyWarning?: boolean;
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
      nativeFallbacks: summary.nativeFallbacks,
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
  // Lifetime tokens routed per lane (the summary is global ⇒ all events).
  const byLane = core.tokenStats(events).byLane;
  // Per-lane routed-task timestamps for the 5h request window (excludes native
  // breadcrumbs — those never ran on a lane and are not "routed" work).
  const routedTsByLane = new Map<string, number[]>();
  for (const e of events) {
    if (e.event_type !== 'task' || e.status === 'native') continue;
    const ms = Date.parse(e.ts);
    if (!Number.isFinite(ms)) continue;
    let arr = routedTsByLane.get(e.laneId);
    if (!arr) {
      arr = [];
      routedTsByLane.set(e.laneId, arr);
    }
    arr.push(ms);
  }
  // Fold the host CLI's own per-model usage into per-lane counts, attributing each
  // model's tokens to AT MOST ONE lane (the first whose resolved model matches) so a
  // model shared by two lanes (e.g. a CLI + an API lane) isn't double-counted.
  const cliUsageByModel = input.cliUsageByModel;
  const cliConsumed = new Set<string>();
  const laneSummaries: LaneSummary[] = lanes.map((l) => {
    const s = staleByLane.get(l.id);
    const cu = cliUsageByModel?.[l.model];
    let cliTokens = 0;
    if (cu && !cliConsumed.has(l.model)) {
      cliConsumed.add(l.model);
      cliTokens = cu.in + cu.out;
    }
    // B: honor a configured window_ms override so this count always agrees with
    // the quota state routing uses (count parity + honest labeling).
    const windowMs = typeof l.window_ms === 'number' && l.window_ms > 0 ? l.window_ms : FIVE_HOUR_MS;
    const requestsIn5h = core.requestsInWindow(routedTsByLane.get(l.id) ?? [], now, windowMs);
    const limit = l.requests_per_window;
    const requestWindowLevel =
      limit !== undefined ? core.windowLevel(core.windowUsedFraction(requestsIn5h, limit)) : undefined;
    // B: weekly axes (requests_per_week / tokens_per_week) so weekly-only caps
    // alert and gate forecasts too — not just the rolling window.
    const weekState = core.laneQuotaState?.(input.events, l, now);
    const weekLevels = [weekState?.weekRequests?.level, weekState?.weekTokens?.level];
    const weekLevel = weekLevels.includes('critical') ? 'critical' : weekLevels.includes('warn') ? 'warn' : undefined;
    const weekDetail = weekState
      ? [
          ...(weekState.weekRequests ? [`7d ${weekState.weekRequests.count}/${weekState.weekRequests.limit} req`] : []),
          ...(weekState.weekTokens
            ? [`7d ${Math.round(weekState.weekTokens.count).toLocaleString('en-US')}/${weekState.weekTokens.limit.toLocaleString('en-US')} tok`]
            : []),
        ].join(' · ')
      : '';
    // B3: project depletion ONLY for lanes at warn/critical on ANY configured
    // axis (the quiet majority get no forecast churn).
    const anyPressure =
      requestWindowLevel === 'warn' || requestWindowLevel === 'critical' || weekLevel !== undefined;
    const forecast = core.laneDepletionForecast && anyPressure ? core.laneDepletionForecast(input.events, l, now) : undefined;
    return {
      id: l.id,
      kind: l.kind,
      model: l.model,
      trustMode: l.trust_mode,
      provenance: l.provenance,
      tokensRouted: (byLane[l.id]?.total ?? 0) + cliTokens,
      requestsIn5h,
      ...(windowMs !== FIVE_HOUR_MS ? { windowHours: windowMs / 3_600_000 } : {}),
      ...(limit !== undefined ? { requestsPerWindow: limit, requestWindowLevel } : {}),
      ...(weekLevel && weekDetail ? { weekLevel, weekDetail } : {}),
      ...(forecast ? (forecast.confidence === 'moderate' ? { forecastEtaMs: forecast.etaMs } : { forecastLow: true }) : {}),
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
    ...(input.meteredKeyWarning ? { meteredKeyWarning: true } : {}),
    empty: lifetime.offloads === 0,
  };
}

// --- rendering (dependency-free: pure data → string) ---------------------------

export const METERED_KEY_WARNING =
  '   ⚠ ANTHROPIC_API_KEY is set — Claude Code bills per-token (metered) even on a Max/Pro plan. Unset it to use your subscription quota.';

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
    const off = '⏸  TokenMaxed routing is OFF for this project — run /tokenmaxed:on to re-enable.';
    return data.meteredKeyWarning ? `${off}\n${METERED_KEY_WARNING}` : off;
  }
  const lines: string[] = [];
  if (data.empty) {
    lines.push('🟢 TokenMaxed — ready. No routed work yet; your savings will show here.');
    if (data.meteredKeyWarning) lines.push(METERED_KEY_WARNING);
  } else {
    lines.push('🟢 TokenMaxed — maximizing your flat-rate capacity');
    lines.push(
      `   Saved ${usd(data.meteredAvoidedLifetime)} in metered API spend (lifetime) · ` +
        `${usd(data.meteredAvoided7d)} last 7d`,
    );
    lines.push(`   ${pct(data.zeroMeteredShare)} of routed tokens cost $0 metered`);
    if (data.meteredKeyWarning) lines.push(METERED_KEY_WARNING);
    lines.push('');
    for (const w of data.windows) {
      const nf =
        w.nativeFallbacks > 0 ? ` · ${w.nativeFallbacks} native fallback${w.nativeFallbacks === 1 ? '' : 's'}` : '';
      lines.push(
        `   ${w.label.padEnd(9)}${tok(w.tokens).padStart(9)} tok routed · ` +
          `${usd(w.meteredAvoided)} metered avoided · ${w.offloads} offloads${nf}`,
      );
    }
  }
  lines.push('');
  // Lanes, grouped by access level. Only lanes that are actually SET UP are shown —
  // available AND not blocked. Offline/blocked lanes are hidden entirely (an offline
  // lane isn't usable, so showing "(full)" on it is misleading). Each lane on its own
  // line, named by vendor + the specific model it runs.
  const shown = data.lanes.filter((l) => l.available && l.trustMode !== 'blocked');
  // Cap how many lanes are listed (and how many stale spell-outs follow, below) so a
  // large config can't render a wall — the remainder is summarized with a pointer.
  // Bounds the banner height by construction (the reviewer is still named even if it
  // falls beyond the cap).
  const MAX_LANES = 12;
  const visible = shown.slice(0, MAX_LANES);
  if (shown.length === 0) {
    lines.push('   No lanes set up yet — run /tokenmaxed:setup');
  } else {
    const hidden = shown.length - visible.length;
    const width = Math.max(...visible.map((l) => vendorName(l).length));
    // Per-lane counts are often small, so show the EXACT count (grouped) rather than
    // tok()'s thousands-rounding, which would render e.g. 150 tokens as a misleading "0k".
    const laneLine = (l: LaneSummary): string => {
      const windowLabel = l.windowHours !== undefined ? fmtWindow(l.windowHours * 3_600_000) : '5h';
      const routed5h =
        l.requestsIn5h > 0 || l.requestsPerWindow !== undefined ? ` · routed ${windowLabel}: ${l.requestsIn5h}` : '';
      return `     ${vendorName(l).padEnd(width)}  ${l.model}${l.tokensRouted > 0 ? ` · ${l.tokensRouted.toLocaleString('en-US')} tok` : ''}${routed5h}${l.stale ? ' ⚠ stale' : ''}`;
    };
    const groups: Array<{ title: string; mode: Lane['trust_mode'] }> = [
      { title: 'Full access', mode: 'full' },
      { title: 'Workers', mode: 'worker' },
      { title: 'Readers', mode: 'reader' },
    ];
    for (const { title, mode } of groups) {
      const g = visible.filter((l) => l.trustMode === mode);
      if (g.length === 0) continue;
      lines.push(`   ${title}`);
      for (const l of g) lines.push(laneLine(l));
    }
    if (hidden > 0) {
      lines.push(`     … and ${hidden} more set-up lane${hidden === 1 ? '' : 's'} — /tokenmaxed:summary`);
    }
    const reviewer = shown.find((l) => l.isActiveReviewer);
    if (reviewer) {
      lines.push('   Reviewer');
      lines.push(`     ${vendorName(reviewer).padEnd(width)}  ${reviewer.model}`);
    }
  }
  // SETUP-1 B hint (read-only — only /tokenmaxed:setup records a review). Only when
  // lanes exist (an empty config already nudges to run setup above).
  if (data.lanes.length > 0 && data.laneReview === 'changed') {
    lines.push('   ⚠ your lanes changed since you last reviewed them — run /tokenmaxed:setup to review');
  } else if (data.lanes.length > 0 && data.laneReview === 'first-review') {
    lines.push('   ℹ run /tokenmaxed:setup to review what each lane may see/do');
  }
  // Routed window quota warnings (ledger-only counts — NOT total subscription usage).
  for (const l of visible.filter(
    (x) => x.requestsPerWindow !== undefined && (x.requestWindowLevel === 'warn' || x.requestWindowLevel === 'critical'),
  )) {
    const tag = l.requestWindowLevel === 'critical' ? 'near limit' : 'filling up';
    const windowLabel = l.windowHours !== undefined ? fmtWindow(l.windowHours * 3_600_000) : '5h';
    // B3: confidence controls WHETHER and HOW time renders — moderate ⇒ a
    // relative duration; low ⇒ a timeless notice; neither ⇒ nothing extra.
    const forecast =
      l.forecastEtaMs !== undefined
        ? ` — est. ${fmtEta(l.forecastEtaMs)} at routed pace`
        : l.forecastLow
          ? ' — approaching cap (routed)'
          : '';
    lines.push(
      `   ⚠ ${vendorName(l)} routed ${windowLabel}: ${l.requestsIn5h}/${l.requestsPerWindow} (${tag} — ledger count only, not your full session)${forecast}`,
    );
  }
  // B: weekly-only quota alerts — lanes whose WEEKLY axes are warn/critical while
  // the rolling window (if any) is not; the window loop above already carries the
  // forecast when both are hot, so these never double-render.
  for (const l of visible.filter(
    (x) =>
      x.weekLevel !== undefined && !(x.requestWindowLevel === 'warn' || x.requestWindowLevel === 'critical'),
  )) {
    const tag = l.weekLevel === 'critical' ? 'near limit' : 'filling up';
    const forecast =
      l.forecastEtaMs !== undefined
        ? ` — est. ${fmtEta(l.forecastEtaMs)} at routed pace`
        : l.forecastLow
          ? ' — approaching cap (routed)'
          : '';
    lines.push(`   ⚠ ${vendorName(l)} routed ${l.weekDetail} (${tag} — ledger count only, not your full session)${forecast}`);
  }
  // Spell out stale models, but only for the VISIBLE (capped) lanes — so the spell-out
  // count is bounded by MAX_LANES, never the full set. Offline/blocked lanes are
  // hidden, so their staleness is moot here. (cache-derived; refreshed by /status.)
  for (const l of visible.filter((l) => l.stale)) {
    lines.push(
      l.stale!.newestPriced
        ? `   ⚠ ${vendorName(l)} on ${l.model} — newer available: ${l.stale!.newest} (set model: <family>@latest, or pin it)`
        : `   ⚠ ${vendorName(l)} on ${l.model} — newer ${l.stale!.newest} exists but isn't priced yet`,
    );
  }
  lines.push('   /tokenmaxed:summary anytime · /tokenmaxed:why <category> to preview · /tokenmaxed:savings for detail');
  return lines.join('\n');
}

/** Friendly vendor name for a lane (falls back to the lane id when unmapped). */
const VENDOR_NAME: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'Codex',
  minimax: 'MiniMax',
  google: 'Gemini',
  moonshot: 'Kimi',
  zhipu: 'GLM',
  meta: 'Llama',
  mistral: 'Mistral',
  xai: 'Grok',
  deepseek: 'DeepSeek',
};
function vendorName(l: Pick<LaneSummary, 'provenance' | 'id'>): string {
  return VENDOR_NAME[l.provenance] ?? l.id;
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
 * Budget semantics: `maxChars` is a HARD postcondition — `out.length <= maxChars`
 * for every input (line-aware ellipsis, then a final truncation backstop). `maxLines`
 * is ADVISORY: the drop loop removes lower-value trailing detail (tips → stale → hint)
 * toward it, but it will NOT drop required content (a group of set-up lanes), so a
 * large lane set can exceed it. (The renderer caps the lane list with a "… N more"
 * pointer, so in practice the banner stays small; `maxChars` is the absolute bound.)
 * Both budgets are normalized to NON-NEGATIVE INTEGERS (`Math.max(0, Math.floor(…))`),
 * so negative, zero, and fractional budgets are well-defined (a budget < 1 ⇒ 0 ⇒
 * empty output).
 *
 * Pure string→string so one clamped source can feed BOTH the visible
 * `systemMessage` and the model-context `additionalContext` (kept byte-identical).
 */
export function clampBanner(banner: string, opts: { maxLines?: number; maxChars?: number } = {}): string {
  // Normalize to non-negative integers so the postcondition is exact for any real
  // input (negative/fractional included): a budget < 1 floors to 0 ⇒ empty output.
  // Defaults sized for the grouped layout (headline + windows + a few access groups,
  // each lane on its own line): a typical set-up is ~14–18 lines, so 20/2000 leaves a
  // normal banner untrimmed and only clamps a pathologically large one.
  const maxLines = Math.max(0, Math.floor(opts.maxLines ?? 20));
  const maxChars = Math.max(0, Math.floor(opts.maxChars ?? 2000));
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
    // Never ellipsize the metered-key warning unless it is the only line left.
    let candidates = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line !== METERED_KEY_WARNING || lines.length === 1);
    // Defensive: CLAMP_POINTER is always appended above and is never the warning, so at
    // least one non-warning candidate always exists; this guard only protects against future
    // changes that might remove that invariant.
    if (candidates.length === 0) candidates = lines.map((line, i) => ({ line, i }));
    let idx = candidates[0]!.i;
    for (let k = 1; k < candidates.length; k++) {
      if (lines[candidates[k]!.i]!.length > lines[idx]!.length) idx = candidates[k]!.i;
    }
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
