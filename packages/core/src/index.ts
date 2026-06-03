/** Public surface of the TokenMaxed routing brain. */

export * from './types.ts';
export {
  routeDecide,
  isSelectablePreGate,
  isManagerEligible,
  executionModeOf,
  capabilityFor,
  DEFAULT_CAPABILITY,
} from './route.ts';
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
} from './ledger.ts';
export { evaluate, laneAllowedByVerdict, parsePolicyConfig, PolicyConfigError } from './policy.ts';
export type { PolicyDecision } from './policy.ts';
export { minimize, isMinimizedPayload, scrubText, LIMITS } from './minimize.ts';
export { buildUntrustedRequestBody, isExecutorCertified } from './boundary.ts';
export type { UntrustedLaneDTO, SafeUntrustedEnvelope, UntrustedRequestBody } from './boundary.ts';
export { canReassign, reassignmentTarget, shouldReassign, TRUST_RANK } from './reassign.ts';
export type { ReassignOptions } from './reassign.ts';
export { FAILURE_KINDS, isTransient, shouldCooldown, classifyHttpStatus, LaneFailure } from './failure.ts';
export type { FailureKind } from './failure.ts';
export { review, ReviewError } from './review.ts';
export type { ReviewRequest, ReviewResult, ReviewDeps, ManagerReviewOutput } from './review.ts';
export { runTask, runWithFallback } from './run.ts';
export type {
  RunRequest,
  RunResult,
  RunDeps,
  TrustedExecResult,
  UntrustedExecResultLite,
  FallbackOptions,
  FallbackResult,
} from './run.ts';
export type {
  MinimizedAttachment,
  MinimizedRequest,
  MinimizedPayload,
  MinimizeResult,
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
// File I/O (loadLaneConfig, loadPriceTable, JsonlLedger) lives in the Node
// adapter: import from "@tokenmaxed/core/node" so the core barrel stays free
// of node:fs.
