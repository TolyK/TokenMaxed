/**
 * Core domain types for the TokenMaxed routing brain.
 *
 * This module is host-agnostic: it contains no Claude Code, no I/O, and no
 * network code. Everything here is data + pure logic so the same brain can be
 * driven by the Claude Code adapter, a CLI, or tests.
 */

/** How a lane is invoked. */
export type LaneKind = 'cli' | 'api' | 'local';

/**
 * Trust tier. `trusted` lanes (Claude native, Codex CLI, local models) may see
 * the repo and tools. `untrusted` lanes receive only minimized, scrubbed,
 * bounded, no-tool payloads. No untrusted lane may exist before the
 * minimization/policy gate (M3) ships.
 */
export type Trust = 'trusted' | 'untrusted';

/**
 * Marginal cost model for a lane:
 * - `subscription`: flat-rate CLI (Claude Max, Codex/ChatGPT Pro) — marginal ≈ 0 until caps.
 * - `metered`: pay-per-token API.
 * - `local`: runs on your machine (Ollama) — marginal = 0.
 */
export type CostBasis = 'subscription' | 'metered' | 'local';

/** The fixed v0 task taxonomy (kept small on purpose; full taxonomy is out of scope for v0). */
export type TaskCategory =
  | 'boilerplate'
  | 'bugfix'
  | 'refactor'
  | 'explain'
  | 'feature'
  | 'codegen'
  | 'docs';

/** All task categories, in canonical order. */
export const TASK_CATEGORIES: readonly TaskCategory[] = [
  'boilerplate',
  'bugfix',
  'refactor',
  'explain',
  'feature',
  'codegen',
  'docs',
] as const;

/**
 * A routable lane. Lane identity and trust live ONLY in local config
 * (`lanes.yaml`); the hosted registry feed may overlay reference data
 * (prices, capability scores) but can never create, enable, or re-trust a lane.
 */
export interface Lane {
  /** Stable local identifier, e.g. "claude-native", "codex-cli", "ollama-llama3". */
  id: string;
  kind: LaneKind;
  /** Model id used for pricing/registry lookups, e.g. "claude-opus-4-7". */
  model: string;
  trust: Trust;
  costBasis: CostBasis;
  /** Origin org/vendor, e.g. "anthropic", "openai", "meta", "deepseek". */
  provenance: string;
  /** Legal jurisdiction of the provider, e.g. "US", "CN". */
  jurisdiction: string;
  /**
   * Per-category capability in [0, 1]. A missing category falls back to
   * {@link DEFAULT_CAPABILITY}. This is the lane's competence at a category,
   * later overlaid by the registry feed's `capability_scores`.
   */
  capability?: Partial<Record<TaskCategory, number>>;
}

/** A unit of work to route. v0 needs only its category to decide a lane. */
export interface Task {
  category: TaskCategory;
}

/**
 * Token usage for a single executed task. Both counts are non-negative
 * integers. Any provider cache-read/cache-write tokens are folded into
 * `tokens_in` (P1-S5) and priced as ordinary input — never claimed as an
 * off-provider cache discount.
 */
export interface Usage {
  tokens_in: number;
  tokens_out: number;
}

/** Inputs to a routing decision beyond the task itself. */
export interface RouteContext {
  /** The locally-configured candidate lanes. */
  lanes: Lane[];
}

/**
 * Routing policy. In v0 this is intentionally empty (allow-all over trusted
 * lanes); the ordered minimization/policy rules arrive with the M3 gate
 * (P1-S9) before any untrusted/API lane exists.
 */
export interface Policy {
  /** Lane ids that are administratively disabled and must never be selected. */
  disabledLaneIds?: string[];
}

/** A single lane's score, with the factors that produced it (for `/router:why`). */
export interface LaneScore {
  laneId: string;
  score: number;
  factors: {
    /** Capability for the task category, in [0, 1]. */
    capability: number;
    /** Cost-basis penalty (higher = more expensive marginal cost). */
    costPenalty: number;
  };
}

/** The result of a pure routing decision. */
export interface RouteDecision {
  /** The chosen lane's id. */
  laneId: string;
  /** A human-readable explanation of why this lane won. */
  reason: string;
  /** Every candidate's score, sorted best-first (deterministic). */
  scores: LaneScore[];
}
