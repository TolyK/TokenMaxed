import type { TaskFingerprint } from './fingerprint.ts';

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

/** The coding domain's fixed category union — strong typing for coding-domain internals. */
export type CodingCategory =
  | 'boilerplate'
  | 'bugfix'
  | 'refactor'
  | 'explain'
  | 'feature'
  | 'codegen'
  | 'docs';

/**
 * A task category WIRE id (bare string, e.g. "bugfix"). Runtime-validated against the
 * taxonomy registry (see taxonomy.ts) instead of a compile-time union, so task domains
 * are runtime-pluggable. Coding's categories are {@link CodingCategory}.
 */
export type TaskCategory = string;

/** All task categories, in canonical order. */
export const TASK_CATEGORIES: readonly CodingCategory[] = [
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
   * "minimax"). The family is never guessed from the id by prefix: it comes from this
   * field, or — for a model that's PRICED — from the price table's `family` metadata,
   * so a priced pin is checked without this field. Set it to enable staleness on an
   * UNPRICED concrete pin. For a `<family>@latest` alias the family is the alias stem.
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
   * {@link DEFAULT_CAPABILITY}. This is the lane's offline/unranked floor when
   * the rankings prior overlay has no entry; set `capability_source: pinned` to
   * ignore the overlay and trust this number instead.
   */
  capability?: Partial<Record<TaskCategory, number>>;
  /**
   * When `pinned`, the hand-set {@link capability} wins over the rankings prior
   * overlay for this lane. Absent ⇒ overlay prior applies when present.
   */
  capability_source?: CapabilitySource;
  /**
   * Optional per-5h rolling-window request limit for subscription plans that gate
   * on request count (e.g. Claude Max). Absent ⇒ no limit configured; the summary
   * still shows routed request counts but does not emit quota warnings.
   */
  requests_per_window?: number;
  /**
   * B: override the rolling window length (ms) for {@link requests_per_window}.
   * Absent ⇒ the 5h default. Positive finite ms.
   */
  window_ms?: number;
  /**
   * B: trailing-7-day request cap. All quota counts are the ROUTED share from
   * the local ledger — never total subscription usage (honesty law).
   */
  requests_per_week?: number;
  /** B: trailing-7-day token cap (tokens_in + tokens_out), routed share only. */
  tokens_per_week?: number;
  /** B: optional capacity reserve fraction (0..1). */
  reserve_fraction?: number;
  /** B: optional manual calibration fraction (0..1). */
  calibration_fraction?: number;
  /**
   * F: host allowlist — the host frameworks this lane may be selected under
   * (e.g. ['claude-code', 'cli']). ABSENT ⇒ allowed everywhere (back-compat).
   * PRESENT ⇒ the routing context's host must be present AND listed — an
   * unknown/mis-threaded host FAILS CLOSED (missing identity grants less
   * authority, never more). Adding a host here is YOUR acknowledgement of the
   * relevant vendor's terms for running this lane inside that framework — it
   * is not a claim that the use is permitted. Not YOLO-overridable (host rules
   * encode third-party terms, not your own data-trust choices).
   */
  hosts?: string[];
}

/**
 * How a lane's hand-set {@link Lane.capability} interacts with the rankings prior
 * overlay. Only `pinned` is defined in v1.
 */
export type CapabilitySource = 'pinned';

/**
 * Raw rankings evidence for one lane × category prior entry. Carried through to
 * `/why` for honesty — never treated as ground truth.
 */
export interface CapabilityPriorEvidence {
  /** Normalized prior value in [0, 1] (coarse bucket / calibrated score). */
  value: number;
  /** Rankings source id, e.g. `mercor-apex-v1`. */
  source: string;
  /** Chart id within the source. */
  chart: string;
  rank?: number;
  score?: number;
  /** ISO date of the chart snapshot used. */
  date: string;
  /** Chart size when known. */
  n?: number;
  confidence: 'low' | 'moderate' | 'high';
}

/**
 * Rankings-sourced capability PRIOR overlay, keyed by lane id then category.
 * Feeds ONLY the declared-prior slot of {@link effectiveCapability}; separate
 * from the F-1 observed overlay. Never mutates {@link Lane.capability}.
 */
export type CapabilityPriorOverlay = Record<string, Partial<Record<TaskCategory, CapabilityPriorEvidence>>>;

/** Provenance of a resolved rankings prior for `/why` and debugging. */
export type PriorProvenance = 'opt-out' | 'pinned' | 'overlay' | 'overlay-stale' | 'fallback' | 'default';

/** Result of {@link resolvedPriorFor} — the prior slot before F-1 blending. */
export interface ResolvedPrior {
  prior: number;
  priorStrength: number;
  provenance: PriorProvenance;
  evidence?: CapabilityPriorEvidence;
  /** True when the overlay value was clamped by the ±Δ or stale-upward cap. */
  clamped?: boolean;
  /** True when no chart match exists for this lane×category (fallback used). */
  unranked?: boolean;
}

/** Provenances treated as trusted-by-origin (locally executed or first-party). */
export const TRUSTED_PROVENANCES: readonly string[] = ['anthropic', 'openai', 'google', 'meta'];

/**
 * Bounded difficulty bucket (content-free enum). Recorded on outcomes from the
 * escalation stage (P6 §4); optionally supplied on a task to condition the
 * capability lookup on the difficulty-specific pass record.
 */
export type DifficultyBucket = 'easy' | 'moderate' | 'hard';
export const DIFFICULTY_BUCKETS: readonly DifficultyBucket[] = ['easy', 'moderate', 'hard'];

/** A unit of work to route. v0 needs only its category to decide a lane. */
export interface Task {
  category: TaskCategory;
  /**
   * Optional expected/observed difficulty. When set AND a learned
   * {@link RouteContext.observedCapabilityByModelDifficulty} cell has evidence,
   * routing conditions capability on that cell (back-off ladder). Absent ⇒
   * category-level behavior, byte-identical to before difficulty existed.
   * Escalation retries set this from the review stage ('hard' for an escalated
   * leg); callers may set it explicitly for work they know is hard.
   */
  difficulty?: DifficultyBucket;
}

/** Caller-supplied access need for a task; `auto` defers the decision to `inferAccessNeed`. */
export type AccessNeedInput = 'worker-ok' | 'repo-tight' | 'auto';

/**
 * Resolved access requirement the router gates on (never `auto`). `repo-tight`
 * restricts a task to full-access lanes; `worker-ok` imposes no access restriction
 * (the data-egress policy still applies independently).
 */
export type AccessNeed = 'worker-ok' | 'repo-tight';

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

/**
 * Observed capability evidence keyed by resolved model id then task category (P6).
 * A learned overlay on top of the declared config prior; absent entries fall back
 * to declared capability. Sparse by construction (only models/categories with
 * evidence appear).
 */
export type ObservedCapabilityByModel = Record<string, Partial<Record<TaskCategory, ObservedCapability>>>;

/**
 * Observed capability evidence keyed by resolved model id, task category, then
 * difficulty bucket (P6 §4). The difficulty-conditioned view of
 * {@link ObservedCapabilityByModel}: a cell holds the decay-weighted pass record
 * for work whose review landed in that bucket. Sparse; outcomes recorded without
 * a difficulty are excluded here (they still feed the category-level view).
 * NOTE the bucket is escalation-depth under the active reviewer — a behavioral
 * proxy for hardness, not ground truth (see feedback.ts banner).
 */
export type ObservedCapabilityByModelDifficulty = Record<
  string,
  Partial<Record<TaskCategory, Partial<Record<DifficultyBucket, ObservedCapability>>>>
>;

export interface RouteContext {
  /** The locally-configured candidate lanes. */
  lanes: Lane[];
  /** Rich task fingerprint for sub-signals (backlog #6). */
  fingerprint?: TaskFingerprint;
  /**
   * Lane ids the user explicitly authorized to be elevated from `reader` to full repo access
   * (per-project grant or per-prompt flag, resolved by the adapter). Absent ⇒ no elevation,
   * byte-identical to before. Only affects `reader` lanes.
   */
  fullAccessLaneIds?: readonly string[];
  /**
   * F: the host framework this routing runs under (lowercase id, e.g.
   * 'claude-code' | 'codex-cli' | 'cli'). Set by each adapter (TOKENMAXED_HOST).
   * Consumed ONLY by {@link Lane.hosts} allowlists; absent + no allowlists ⇒
   * byte-identical routing.
   */
  host?: string;
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
   * Optional model-keyed learned capability overlay (P6 F-1). When present,
   * routing, reassignment, and escalation-target selection resolve each lane to
   * its canonical model key and blend observed review evidence from that model's
   * cell. Takes precedence over {@link observedCapability} when both are set.
   * Absent ⇒ falls back to lane-keyed overlay, then declared capability.
   * Reviewer-manager selection and the `capability: 0` opt-out always stay on
   * the DECLARED score regardless of this overlay.
   */
  observedCapabilityByModel?: ObservedCapabilityByModel;
  /**
   * Optional difficulty-conditioned learned overlay (P6 §4). Consulted ONLY when
   * the task carries a {@link Task.difficulty}: the matching model×category×
   * difficulty cell (when it has evidence) is blended on top of the category-level
   * effective capability via the same shrinkage form (back-off ladder:
   * difficulty cell → category cell → declared/prior). Absent, or no task
   * difficulty, or an empty cell ⇒ byte-identical to the category-level score.
   * Reviewer-manager selection and the `capability: 0` opt-out are unaffected.
   */
  observedCapabilityByModelDifficulty?: ObservedCapabilityByModelDifficulty;
  /**
   * Optional rankings-sourced capability PRIOR overlay (separate from F-1
   * {@link observedCapability}). When present, routing and escalation read the
   * resolved rankings prior instead of the raw declared score for the prior
   * slot; F-1 observed evidence still blends on top unchanged. Absent ⇒
   * byte-identical to declared capability. Reviewer eligibility and the
   * `capability: 0` opt-out always stay on the DECLARED score.
   */
  capabilityPrior?: CapabilityPriorOverlay;
  /**
   * When true, cached rankings priors may decrease but MUST NOT increase any
   * previously-accepted prior (stale-feed integrity rule).
   */
  capabilityPriorStale?: boolean;
  /**
   * Previously-accepted overlay prior values per lane×category, used for the
   * per-refresh ±Δ movement cap. Absent for a slot ⇒ first-acceptance baseline
   * is the resolved local fallback after opt-out/pinned handling.
   */
  capabilityPriorAccepted?: Record<string, Partial<Record<TaskCategory, number>>>;
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
   * Legacy routing strategy (MODEL-TIERS). Deprecated: use `routingPolicy` instead.
   * Maps `tiered` to `cheapest` policy, and `maximize` to `balanced` policy.
   * If both are provided, `routingPolicy` takes precedence.
   */
  strategy?: 'maximize' | 'tiered';
  /**
   * Named routing policy. If provided, overrides/precedes legacy `strategy`.
   * - `balanced` (DEFAULT) — capability − cost − quota − health.
   * - `cheapest` — cheapest lane clearing the capability floor, step up only when needed (tiered).
   * - `preserve-frontier` — conserve most capable/expensive lanes by adding a cost-scaled penalty.
   * - `reliable` — weight lane health signal more heavily.
   */
  routingPolicy?: 'balanced' | 'cheapest' | 'preserve-frontier' | 'reliable';
  /** Tiered floor: minimum effective capability a lane must clear (default ~0.6). */
  tierFloor?: number;
  /** Per-category overrides for {@link tierFloor}. */
  tierFloorByCategory?: Partial<Record<TaskCategory, number>>;
  /**
   * Optional per-lane cost signal (e.g. resolved-model input+output $/1M from the
   * price table) used by `tiered` selection to rank "cheapest" — coarse `costBasis`
   * can't separate same-basis tiers (Haiku vs Opus). Absent for a lane ⇒ fall back
   * to its `costBasis` penalty. Supplied by the host adapter (core stays pure).
   */
  laneCost?: Record<string, number>;
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
  /**
   * Optional explicit lane preference (universal "offload this sprint" override):
   * the id of ANY configured lane the user wants routing to favor — any vendor,
   * CLI or API. When set and that lane is an eligible+available candidate that is
   * NOT a hard opt-out (effective capability > 0 for the category), `routeDecide`
   * picks it over the normal capability ranking. It NEVER relaxes the hard rails
   * (gate, policy, sensitivity/repo_class, executor certification, availability):
   * an ineligible or unknown preferred lane is ignored and routing falls back to
   * the normal ranking. Set by the host adapter from a per-project toggle / env so
   * the user can flip "use lane X for now" on and off easily without a relaunch.
   */
  preferLaneId?: string;
  /**
   * Resolved access requirement of the task (tandem routing). `repo-tight` means
   * the work needs full repo/tool/shell access, so worker AND reader lanes are
   * filtered out before scoring and only `full` lanes survive — independent of the
   * data-egress policy (which stays about repo_class/sensitivity/secrets). Always
   * the RESOLVED value (`worker-ok` | `repo-tight`), never `auto`: the host adapter
   * collapses `auto`/unset via `inferAccessNeed` before routing. Absent ⇒
   * `worker-ok` (no access restriction), identical to before this feature.
   */
  access_need?: AccessNeed;
  /**
   * YOLO — the `--dangerously-skip-permissions` analogue. When `true`, the
   * structural trust gate and the data-egress policy gate are forced OPEN so EVERY
   * configured worker/reader lane is selectable: `gateReady`/`readerEgress` are
   * treated as `true`, the per-lane `repo_read_attestation` and reader hard cap are
   * waived, and a `force-trusted` verdict (deny-by-default, sensitive/private repo,
   * secret-on-allow) no longer restricts a lane to `full`. It does NOT relax two
   * things: an explicit `disabledLaneIds` entry or an explicit policy `block` rule
   * (deliberate operator kill-switches, honored like a permission deny-rule), and a
   * lane whose tier has no egress-certified executor (a code-capability fact, not a
   * permission). Orthogonal protections — the secret scanner and the user-owned
   * config / RCE guard — live outside routing and are unaffected. Absent/`false` ⇒
   * normal gated routing, identical to before this feature.
   */
  yolo?: boolean;
  /**
   * Optional health penalty per lane id, subtracted from the score.
   * Sparse: only lanes with failure evidence get an entry.
   */
  healthPenalty?: Record<string, number>;
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
    /** Health penalty (0 when healthy; larger when lane has recent failures). */
    healthPenalty?: number;
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
