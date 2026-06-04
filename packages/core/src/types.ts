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
 * from `provenance`). Trust ladder (low→high): `blocked < worker < reader < full`.
 * - `full`: may see repo + tools + broad context (trusted, user-approved lanes);
 *   the only tier that may be `agentic`.
 * - `reader` (F-2): may receive bounded, scanned, scrubbed **repo-read** context
 *   (so repo-aware work can offload) but NEVER secrets, shell, write, or tools —
 *   answer-only. This DELIBERATELY sends (possibly private) repo code to the
 *   vendor: secret egress is fail-closed + scanner-gated, *not proven impossible*,
 *   so it is opt-in (global egress flag + per-lane `repo_read_attestation`) and the
 *   lane only ever gets a bounded payload, never a repo handle. NOT the old
 *   "no-leak" guarantee — a clearer, safer alternative to marking a vendor `full`.
 * - `worker`: receives only a minimized, scrubbed, bounded, no-tool task — never
 *   the repo/secrets/tools.
 * - `blocked`: never selected.
 *
 * No non-`full` lane may run until the minimization/policy gate is ready
 * (`gate.ready`) and the lane's executor is egress-certified.
 *
 * `monitored` is a DEPRECATED alias for `reader`, accepted by the config parser
 * (normalized to `reader`) for back-compat; it is never the canonical value.
 */
export type TrustMode = 'full' | 'worker' | 'reader' | 'blocked';

/** All trust modes, canonical order. */
export const TRUST_MODES: readonly TrustMode[] = ['full', 'worker', 'reader', 'blocked'];

/** Deprecated config alias → canonical trust mode (only `monitored` → `reader` today). */
export const TRUST_MODE_ALIASES: Readonly<Record<string, TrustMode>> = { monitored: 'reader' };

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
  /**
   * Model id used for pricing/registry lookups, e.g. "claude-opus-4-7". May be a
   * `<family>@latest` alias (resolved to a concrete id by the host adapter before
   * pricing/execution).
   */
  model: string;
  /**
   * Optional EXPLICIT model family for staleness checks on a pinned `model` (e.g.
   * "minimax"). Required to flag staleness on a concrete id (family is never guessed
   * from the id by prefix). For a `<family>@latest` alias the family is the alias
   * stem, so this is not needed.
   */
  model_family?: string;
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
  /** For `cli` lanes: the executable to spawn (e.g. "codex", "gemini"). */
  command?: string;
  /** For `cli` lanes: argument template passed to the command. */
  args?: string[];
  /** For `api`/`local` lanes: the endpoint URL (e.g. an OpenAI-compatible URL or Ollama). */
  endpoint?: string;
  /** For `api` lanes: opaque reference to a credential (resolved to a token at send time). */
  authHandle?: string;
  /** Marks the host/"do it yourself" lane (e.g. Claude in Claude Code) — executed natively, not recorded. */
  native?: boolean;
  /**
   * Explicit, high-friction user attestation that an otherwise non-trusted-
   * provenance lane is trusted enough to be manager-eligible. Default false.
   */
  attestation?: boolean;
  /**
   * F-2: explicit, high-friction user attestation authorizing **private repo-read
   * egress** to this `reader` lane's vendor ("private source code may be sent to
   * this provider"). Distinct from {@link attestation} (manager eligibility) and
   * required, alongside the global egress flag, before a `reader` lane is
   * selectable. Only valid on a `reader` lane. Default false.
   */
  repo_read_attestation?: boolean;
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
/**
 * Observed review evidence for one lane × category (F-1 capability feedback).
 * Content-free: derived purely from manager-review verdict counts in the ledger.
 */
export interface ObservedCapability {
  /** Recency-decayed success rate in [0, 1] — the dogfood scale `(pass + ½·needs-rework)/total`. */
  rate: number;
  /** Effective (decay-weighted) sample count: the confidence mass behind `rate`. */
  n: number;
}

/**
 * Observed capability evidence keyed by lane id then task category. A learned
 * overlay on top of the declared config prior; absent entries fall back to
 * declared capability. Sparse by construction (only lanes/categories with
 * evidence appear).
 */
export type ObservedCapabilityByLane = Record<string, Partial<Record<TaskCategory, ObservedCapability>>>;

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
   * Optional learned capability overlay (F-1). When present, routing,
   * reassignment, and escalation-target selection use the EFFECTIVE capability
   * (declared prior blended with observed review evidence) instead of the raw
   * declared score. Absent ⇒ declared capability is used everywhere, identical to
   * before the feedback loop. Reviewer-manager selection and the `capability: 0`
   * opt-out always stay on the DECLARED score regardless of this overlay.
   */
  observedCapability?: ObservedCapabilityByLane;
  /**
   * Whether the minimization/policy gate is built and CI-green. Defaults to
   * `false`. While false, only `full`, non-API lanes are selectable (non-`full`
   * lanes are rejected regardless of config).
   */
  gateReady?: boolean;
  /**
   * F-2: whether the global reader-egress opt-in (`TOKENMAXED_READER_EGRESS`) is
   * on. Required (with the gate, an API reader executor, and a per-lane
   * `repo_read_attestation`) before a `reader` lane is selectable. Default false ⇒
   * reader lanes are never selected.
   */
  readerEgress?: boolean;
  /** Task-level context the policy gate evaluates against (defaults to unknown/sensitive). */
  policyContext?: PolicyContext;
  /**
   * Optional ids of lanes that can actually RUN right now — e.g. the provider CLI
   * is installed, the local model server is reachable, the BYOK key is present.
   * When provided, a non-native lane is a routing candidate ONLY if its id is
   * listed, so a configured-but-unavailable lane (Ollama down, CLI not installed,
   * key missing) is never selected. The native host lane is always available and
   * is exempt from this filter. Absent ⇒ availability is not checked (every
   * configured lane is treated as available), identical to before this feature.
   * Availability is determined by the host adapter (it does the I/O); the core
   * stays pure and only reads the resulting id list.
   */
  availableLaneIds?: readonly string[];
}

/**
 * Verdict of the policy gate for a (task, lane) pair:
 * - `allow`: the lane may handle this task.
 * - `block`: the lane must not handle this task (excluded entirely).
 * - `force-trusted`: only a `full`/trusted lane may handle this task (a non-`full`
 *   lane receiving this verdict is excluded).
 */
export type PolicyVerdict = 'allow' | 'block' | 'force-trusted';

/** All policy verdicts, canonical order. */
export const POLICY_VERDICTS: readonly PolicyVerdict[] = ['allow', 'block', 'force-trusted'];

/** Classification of the repository the task touches. `unknown` is treated as sensitive. */
export type RepoClass = 'public' | 'private' | 'unknown';

/** Sensitivity of the path/payload involved. `unknown` is treated as sensitive. */
export type Sensitivity = 'normal' | 'sensitive' | 'unknown';

/**
 * Task-level context the policy gate evaluates against. Sourced from explicit
 * adapter input or local config; any field omitted defaults to its `unknown`
 * value and is treated as sensitive (deny-by-default).
 */
export interface PolicyContext {
  repo_class?: RepoClass;
  sensitivity?: Sensitivity;
  /** A secret was detected in the candidate payload ⇒ trusted/local only. */
  secretHit?: boolean;
}

/**
 * An ordered policy rule. A condition that is omitted matches anything; a
 * condition given as an array matches if the value is in the array. The first
 * matching rule (in order) decides the verdict.
 */
export interface PolicyRule {
  repo_class?: RepoClass | RepoClass[];
  sensitivity?: Sensitivity | Sensitivity[];
  trust_mode?: TrustMode | TrustMode[];
  provenance?: string | string[];
  jurisdiction?: string | string[];
  category?: TaskCategory | TaskCategory[];
  verdict: PolicyVerdict;
  reason?: string;
}

/**
 * Routing policy. Ordered `rules` are evaluated by the policy engine
 * (`policy.ts`); when no rule matches, a deny-by-default baseline applies.
 */
export interface Policy {
  /** Ordered rules; first match wins. */
  rules?: PolicyRule[];
  /** Lane ids that are administratively disabled and must never be selected. */
  disabledLaneIds?: string[];
}

/** A single lane's score, with the factors that produced it (for `/router:why`). */
export interface LaneScore {
  laneId: string;
  score: number;
  factors: {
    /**
     * The EFFECTIVE capability that drove the score, in [0, 1]: the declared
     * prior blended with observed review evidence when a learned overlay is
     * present, else exactly the declared score.
     */
    capability: number;
    /** Cost-basis penalty (higher = more expensive marginal cost). */
    costPenalty: number;
    /** Weekly-cap penalty (0 when healthy; larger as the lane nears/exceeds its cap). */
    capPenalty: number;
    /** The declared (config-prior) capability, before any learned adjustment. */
    declared: number;
    /** Decay-weighted review evidence behind the adjustment (0 ⇒ no evidence; capability == declared). */
    evidenceN: number;
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
  /** The policy verdict for the chosen lane (`allow` or `force-trusted`). */
  policyVerdict: PolicyVerdict;
}
