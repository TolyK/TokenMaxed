/**
 * Token estimation + subscription-cap tracking (P1-S5). Pure: no I/O.
 *
 * Some lanes (Ollama/local, and some CLIs) don't report token usage, so we
 * estimate it heuristically and flag the event `tokens_estimated: true`. We also
 * track how much of a subscription lane's weekly cap has been consumed and
 * surface warn/critical alerts as it fills, which routing uses to deprioritize
 * near-cap lanes.
 */

import type { Usage } from './types.ts';

/** Cap consumption thresholds (fraction of weekly cap used). */
export const CAP_WARN_USED = 0.7;
export const CAP_CRITICAL_USED = 0.9;

/** A lane's cap status. */
export type CapLevel = 'ok' | 'warn' | 'critical';

/** Raw, possibly-partial usage as reported by a provider/CLI. */
export interface RawUsage {
  tokens_in?: number;
  tokens_out?: number;
  /** Provider cache tokens — folded into tokens_in, never claimed as cache savings. */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Usage plus whether it was estimated (heuristic) vs reported by the lane. */
export interface ResolvedUsage extends Usage {
  tokens_estimated: boolean;
}

/** Raised for invalid reported usage. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Heuristic token estimate for a piece of text (~4 characters per token). Used
 * only when a lane does not report real usage. Returns a non-negative integer.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

function reportedInt(value: number | undefined, where: string): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new UsageError(`${where} must be a non-negative integer (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/**
 * Resolve final usage for a task. If the lane reported both input and output
 * token counts, use them (folding any cache-read/creation tokens into
 * `tokens_in`) and mark the result reported. Otherwise estimate from the
 * prompt/result text and mark it estimated.
 */
export function resolveUsage(args: {
  reported?: RawUsage;
  promptText?: string;
  resultText?: string;
}): ResolvedUsage {
  const { reported, promptText = '', resultText = '' } = args;
  const hasReported =
    reported !== undefined &&
    typeof reported.tokens_in === 'number' &&
    typeof reported.tokens_out === 'number';

  if (hasReported) {
    const baseIn = reportedInt(reported.tokens_in, 'reported.tokens_in');
    const out = reportedInt(reported.tokens_out, 'reported.tokens_out');
    const cacheRead = reportedInt(reported.cache_read_input_tokens, 'reported.cache_read_input_tokens');
    const cacheCreate = reportedInt(
      reported.cache_creation_input_tokens,
      'reported.cache_creation_input_tokens',
    );
    return {
      // Cache tokens count as input usage; we never claim them as cache savings.
      tokens_in: baseIn + cacheRead + cacheCreate,
      tokens_out: out,
      tokens_estimated: false,
    };
  }

  return {
    tokens_in: estimateTokens(promptText),
    tokens_out: estimateTokens(resultText),
    tokens_estimated: true,
  };
}

/**
 * Build usage from a possibly-partial reported record (missing side ⇒ 0, cache
 * tokens folded into input), marked reported. Used to preserve whatever spend a
 * lane reported even on a failed/partial attempt (so spend is never under-counted).
 * Defensive: coerces to non-negative integers rather than throwing.
 */
export function usageFromReported(reported: RawUsage): ResolvedUsage {
  const toInt = (n: number | undefined): number => {
    const v = Math.floor(Number(n));
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const tokens_in =
    toInt(reported.tokens_in) +
    toInt(reported.cache_read_input_tokens) +
    toInt(reported.cache_creation_input_tokens);
  return { tokens_in, tokens_out: toInt(reported.tokens_out), tokens_estimated: false };
}

/** Fraction of the weekly cap consumed, in [0, ∞). 0 when there is no cap (cap <= 0). */
export function capUsedFraction(consumedTokens: number, weeklyCap: number): number {
  if (weeklyCap <= 0) return 0;
  return consumedTokens / weeklyCap;
}

/** Remaining headroom in [0, 1]. 1 when there is no cap (cap <= 0). */
export function capHeadroom(consumedTokens: number, weeklyCap: number): number {
  if (weeklyCap <= 0) return 1;
  const remaining = 1 - consumedTokens / weeklyCap;
  if (remaining < 0) return 0;
  if (remaining > 1) return 1;
  return remaining;
}

/** Classify a used-fraction into ok / warn / critical. */
export function capLevel(usedFraction: number): CapLevel {
  if (usedFraction >= CAP_CRITICAL_USED) return 'critical';
  if (usedFraction >= CAP_WARN_USED) return 'warn';
  return 'ok';
}

/**
 * Which alert thresholds were newly crossed moving from `prevUsed` to `curUsed`,
 * so each of `warn`/`critical` fires exactly once across its crossing. Returns
 * the crossed levels in ascending severity.
 */
export function alertsCrossed(prevUsed: number, curUsed: number): CapLevel[] {
  const crossed: CapLevel[] = [];
  if (prevUsed < CAP_WARN_USED && curUsed >= CAP_WARN_USED) crossed.push('warn');
  if (prevUsed < CAP_CRITICAL_USED && curUsed >= CAP_CRITICAL_USED) crossed.push('critical');
  return crossed;
}
