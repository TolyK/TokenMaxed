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
// File I/O (loadLaneConfig, loadPriceTable) lives in the Node adapter: import
// from "@tokenmaxed/core/node" so the core barrel stays free of node:fs.
