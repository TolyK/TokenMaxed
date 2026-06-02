/** Public surface of the TokenMaxed routing brain. */

export * from './types.ts';
export {
  routeDecide,
  isSelectablePreGate,
  capabilityFor,
  DEFAULT_CAPABILITY,
} from './route.ts';
export { LaneRegistry, LaneConfigError, parseLaneConfig } from './registry.ts';
// File I/O (loadLaneConfig) lives in the Node adapter: import from
// "@tokenmaxed/core/node" so the core barrel stays free of node:fs.
