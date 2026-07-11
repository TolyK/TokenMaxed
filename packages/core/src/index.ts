/** Public surface of the TokenMaxed routing brain. */

export * from './types.ts';
export {
  routeDecide,
  eligibleLanes,
  isSelectablePreGate,
  isManagerEligible,
  executionModeOf,
  canDoRepoTight,
  capabilityFor,
  declaredCapabilityFor,
  effectiveCapability,
  effectiveCapabilityFor,
  effectiveCapabilityOptsFromContext,
  effectiveOptsForTask,
  resolveLaneModelKey,
  DEFAULT_CAPABILITY,
  DEFAULT_PRIOR_STRENGTH,
  DEFAULT_TIER_FLOOR,
} from './route.ts';
export {
  MAX_PRIOR_DELTA,
  PRIOR_STRENGTH_BY_CONFIDENCE,
  priorStrengthFromConfidence,
  resolvedPriorFor,
  clampOverlayPrior,
  validateSnapshot,
  computeSnapshotHash,
  overlayFromSnapshot,
  priorOptsFromContext,
} from './capability-prior.ts';
export type {
  ResolvedPriorOptions,
  CapabilitySnapshot,
  CapabilitySnapshotEntry,
  ValidateSnapshotResult,
  OverlayFromSnapshotOptions,
  OverlayBuildResult,
} from './capability-prior.ts';
export type { EffectiveCapabilityOptions, EligibleLane } from './route.ts';
export { laneObservations, laneQuotaState, quotaHeadroomMap, WEEK_MS } from './quota.ts';
export type { LaneQuotaState, QuotaAxisState, QuotaObservation } from './quota.ts';
export { outcomeCapability, outcomeCapabilityByDifficulty, DEFAULT_HALF_LIFE_DAYS } from './feedback.ts';
export type { OutcomeCapabilityOptions } from './feedback.ts';
export { buildLeaderboard, sortLeaderboard } from './leaderboard.ts';
export type { LeaderboardRow, LeaderboardDifficulty, LeaderboardSortBy } from './leaderboard.ts';
export { LaneRegistry, LaneConfigError, parseLaneConfig } from './registry.ts';
export {
  PriceError,
  validatePriceTable,
  priceForModel,
  computeCostPrimitives,
  aggregateSavings,
} from './price.ts';
export type { ModelPrice, PriceTable, CostPrimitives, SavingsSummary } from './price.ts';
export {
  parseModelAlias,
  compareModelVersion,
  compareNewestFirst,
  pricedIdsInFamily,
  newestPricedInFamily,
  resolveLaneModel,
  staleAgainstPriceTable,
  sameFamily,
  assessStaleness,
  detectModelIdMismatch,
} from './model-freshness.ts';
export type { ModelSpec, FamilyModel, StalenessReport, PriceTableStaleness, ModelIdMismatch } from './model-freshness.ts';
export {
  LedgerError,
  EVENT_FIELDS,
  OUTCOME_EVENT_FIELDS,
  SCHEMA_VERSION,
  validateEventInput,
  validateOutcomeInput,
  serializeEvent,
  parseEvent,
  filterEventsSince,
  summarize,
  tokenStats,
  outcomeStats,
} from './ledger.ts';
export type {
  TaskStatus,
  ReviewVerdict,
  Voter,
  SubjectType,
  TaskEvent,
  TaskEventInput,
  OutcomeEvent,
  OutcomeEventInput,
  LedgerEvent,
  LedgerSummary,
  TokenBucket,
  TokenGroup,
  TokenStats,
  OutcomeGroup,
  OutcomeStats,
  OutcomeAction,
  EscalationStats,
} from './ledger.ts';
export { evaluate, laneAllowedByVerdict, parsePolicyConfig, PolicyConfigError } from './policy.ts';
export type { PolicyDecision } from './policy.ts';
export { minimize, minimizeForReader, isMinimizedPayload, isReaderPayload, scrubText, LIMITS } from './minimize.ts';
export { buildUntrustedRequestBody, isExecutorCertified, buildReaderRequestBody, isReaderExecutorCertified, READER_SYSTEM_FRAMING, WORKER_SYSTEM_FRAMING } from './boundary.ts';
export { inferAccessNeed, parseGiveBackSignal, INSUFFICIENT_CONTEXT_SENTINEL } from './access.ts';
export type { GiveBackSignal } from './access.ts';
export type { UntrustedLaneDTO, SafeUntrustedEnvelope, UntrustedRequestBody, SafeReaderEnvelope, ReaderRequestBody } from './boundary.ts';
export { canReassign, reassignmentTarget, shouldReassign, TRUST_RANK } from './reassign.ts';
export type { ReassignOptions } from './reassign.ts';
export { escalationDecision, selectEscalationTarget } from './reassign.ts';
export type {
  EscalationAction,
  EscalationCounters,
  EscalationCaps,
  EscalationTargetOptions,
} from './reassign.ts';
export { FAILURE_KINDS, isTransient, shouldCooldown, classifyHttpStatus, LaneFailure } from './failure.ts';
export type { FailureKind } from './failure.ts';
export { review, ReviewError } from './review.ts';
export type { ReviewRequest, ReviewResult, ReviewDeps, ManagerReviewOutput } from './review.ts';
export {
  selectReviewManager,
  parseManagerVerdictStrict,
  buildOutputReviewPrompt,
  REVIEW_OUTPUT_MAX_CHARS,
} from './review.ts';
export { runTask, runWithFallback, runWithEscalation } from './run.ts';
export type {
  RunRequest,
  RunResult,
  RunDeps,
  TrustedExecResult,
  UntrustedExecResultLite,
  FallbackOptions,
  FallbackResult,
  EscalationDeps,
  EscalationOptions,
  EscalationResult,
  EscalationEvent,
  EscalationFinalAction,
} from './run.ts';
export type {
  MinimizedAttachment,
  MinimizedRequest,
  MinimizedPayload,
  MinimizeResult,
  ReaderPayload,
  ReaderMinimizeResult,
  SecretScanner,
  SecretScanResult,
} from './minimize.ts';
export {
  UsageError,
  estimateTokens,
  resolveUsage,
  usageFromReported,
  capUsedFraction,
  capHeadroom,
  capLevel,
  alertsCrossed,
  CAP_WARN_USED,
  CAP_CRITICAL_USED,
} from './usage.ts';
export type { RawUsage, ResolvedUsage, CapLevel } from './usage.ts';
export {
  FIVE_HOUR_MS,
  WINDOW_WARN_USED,
  WINDOW_CRITICAL_USED,
  requestsInWindow,
  windowUsedFraction,
  windowHeadroom,
  windowLevel,
  msUntilWindowFrees,
} from './window-quota.ts';
export type { WindowLevel } from './window-quota.ts';
export {
  MIN_CLASSIFY_CONFIDENCE,
  CLASSIFY_FALLBACK_CATEGORY,
  classifyTask,
} from './classify.ts';
export type { Classification } from './classify.ts';
// File I/O (loadLaneConfig, loadPriceTable, JsonlLedger) lives in the Node
// adapter: import from "@tokenmaxed/core/node" so the core barrel stays free
// of node:fs.
