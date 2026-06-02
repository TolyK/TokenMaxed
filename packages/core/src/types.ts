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
 * Trust mode — what *context* a lane may receive (a user choice, kept separate
 * from `provenance`):
 * - `full`: may see repo + tools + broad context (trusted, user-approved lanes).
 * - `worker`: receives only a minimized, scrubbed, bounded, no-tool task — never
 *   the repo/secrets/tools.
 * - `monitored`: deferred (later phase); reserved here so config validates.
 * - `blocked`: never selected.
 *
 * No non-`full` lane may run until the minimization/policy gate is ready
 * (`gate.ready`) and the lane's executor is egress-certified.
 */
export type TrustMode = 'full' | 'worker' | 'monitored' | 'blocked';

/** Roles a lane may be assigned. `manager` reviews work and (re)assigns tasks. */
export type LaneRole = 'manager' | 'worker';

/**
 * Lane autonomy (user-controlled):
 * - `answer-only`: the lane only returns text; it does not edit files or run commands.
 * - `agentic`: the lane may act on its own (edit files / run commands / iterate).
 *   **Permitted ONLY for `trust_mode: 'full'` lanes** — an untrusted `worker` lane
 *   is never agentic-with-access (it always gets only the minimized task).
 */
export type ExecutionMode = 'answer-only' | 'agentic';

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
  /** What context the lane may receive (see {@link TrustMode}). */
  trust_mode: TrustMode;
  costBasis: CostBasis;
  /** Origin org/vendor, e.g. "anthropic", "openai", "meta", "deepseek". */
  provenance: string;
  /** Legal jurisdiction of the provider, e.g. "US", "CN". */
  jurisdiction: string;
  /** Roles this lane is assigned (e.g. `manager`). */
  roles?: LaneRole[];
  /** Whether this lane may act as the manager/reviewer (gated further by eligibility). */
  manager_allowed?: boolean;
  /** Lane autonomy; defaults to `answer-only`. `agentic` requires `trust_mode: 'full'`. */
  execution_mode?: ExecutionMode;
  /**
   * Explicit, high-friction user attestation that an otherwise non-trusted-
   * provenance lane is trusted enough to be manager-eligible. Default false.
   */
  attestation?: boolean;
  /**
   * Per-category capability in [0, 1]. A missing category falls back to
   * {@link DEFAULT_CAPABILITY}. This is the lane's competence at a category,
   * later overlaid by the registry feed's `capability_scores`.
   */
  capability?: Partial<Record<TaskCategory, number>>;
}

/** Provenances treated as trusted-by-origin (locally executed or first-party). */
export const TRUSTED_PROVENANCES: readonly string[] = ['anthropic', 'openai', 'google', 'meta'];

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
  /**
   * Optional remaining weekly-cap headroom per lane id, in [0, 1] (1 = full /
   * no cap). Near-cap subscription lanes are deprioritized; a lane at/over its
   * critical threshold becomes last-resort. A lane absent here is treated as
   * having full headroom.
   */
  capHeadroom?: Record<string, number>;
  /**
   * Whether the minimization/policy gate is built and CI-green. Defaults to
   * `false`. While false, only `full`, non-API lanes are selectable (non-`full`
   * lanes are rejected regardless of config).
   */
  gateReady?: boolean;
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
    /** Weekly-cap penalty (0 when healthy; larger as the lane nears/exceeds its cap). */
    capPenalty: number;
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
