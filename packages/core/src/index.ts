/** Public surface of the TokenMaxed routing brain. */

export * from './types.ts';
export {
  routeDecide,
  isSelectablePreGate,
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
  validateEventInput,
  serializeEvent,
  parseEvent,
  filterEventsSince,
  summarize,
  tokenStats,
} from './ledger.ts';
export type {
  PolicyVerdict,
  TaskEvent,
  TaskEventInput,
  LedgerSummary,
  TokenBucket,
  TokenGroup,
  TokenStats,
} from './ledger.ts';
export {
  UsageError,
  estimateTokens,
  resolveUsage,
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
