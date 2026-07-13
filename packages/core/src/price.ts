/**
 * Pricing + the canonical savings math (P1-S3). Pure: no I/O.
 *
 * Two savings numbers, never one (see the project's honesty rule):
 *  - **Headline (motivational):** estimated frontier-equivalent avoided cost =
 *    the same tokens priced at the most-expensive frontier model, minus what
 *    the lane actually cost.
 *  - **Finance-grade (honest):** metered API dollars avoided / spent.
 *
 * The canonical percentages are defined ONCE here; everything else references
 * them. The denominator is always Σ frontier_cost.
 */

import type { CostBasis, Usage } from './types.ts';
import { estimateTokens } from './usage.ts';

/** Per-model list price, in US dollars per 1,000,000 tokens. */
export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
  /**
   * Optional model-freshness metadata (price table schema_version >= 2). `family`
   * is the EXPLICIT family group used by `@latest` resolution and staleness checks
   * (never inferred from the id by prefix); `released` is an ISO date used to order
   * same-family models newest-first. Both optional so schema_version 1 tables (and
   * user tables without metadata) still load.
   */
  family?: string;
  released?: string;
}

/** A validated price table: per-model list prices plus the frontier baseline. */
export interface PriceTable {
  schema_version: number;
  /** The most-expensive frontier model whose list price is the savings baseline. */
  frontier_model: string;
  models: Record<string, ModelPrice>;
}

/** The five per-task cost primitives persisted on every ledger event (P1-S4). */
export interface CostPrimitives {
  /** Same tokens priced at the frontier model — the canonical denominator. */
  frontier_cost: number;
  /** What the chosen lane actually cost (subscription/local ⇒ 0; metered ⇒ list price). */
  actual_cost: number;
  /** Metered (pay-per-token API) dollars actually spent. */
  metered_spent: number;
  /** frontier_cost − actual_cost (the motivational headline amount). */
  frontier_avoided: number;
  /** frontier_cost − metered_spent (the finance-grade amount). */
  metered_avoided: number;
}

/** The canonical savings percentages plus the sums they were derived from. */
export interface SavingsSummary {
  frontier_cost: number;
  frontier_avoided: number;
  metered_spent: number;
  metered_avoided: number;
  frontier_avoided_pct: number;
  metered_avoided_pct: number;
}

/** Raised for an invalid price table or an unpriceable model. */
export class PriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonNegativeNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new PriceError(`${where} must be a finite number >= 0 (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/** Validate an already-parsed object into a {@link PriceTable}, or throw {@link PriceError}. */
export function validatePriceTable(data: unknown): PriceTable {
  if (!isPlainObject(data)) {
    throw new PriceError('Price table must be a JSON object.');
  }
  if (typeof data.schema_version !== 'number') {
    throw new PriceError('Price table "schema_version" must be a number.');
  }
  if (typeof data.frontier_model !== 'string' || data.frontier_model.trim() === '') {
    throw new PriceError('Price table "frontier_model" must be a non-empty string.');
  }
  if (!isPlainObject(data.models)) {
    throw new PriceError('Price table "models" must be a mapping of model id to prices.');
  }
  // Null-prototype map so a model id that collides with an inherited key
  // (e.g. "toString", "constructor") can never resolve to a prototype member.
  const models: Record<string, ModelPrice> = Object.create(null);
  for (const [model, raw] of Object.entries(data.models)) {
    if (!isPlainObject(raw)) {
      throw new PriceError(`Price table models["${model}"] must be a mapping.`);
    }
    const entry: ModelPrice = {
      inputPer1M: requireNonNegativeNumber(raw.inputPer1M, `models["${model}"].inputPer1M`),
      outputPer1M: requireNonNegativeNumber(raw.outputPer1M, `models["${model}"].outputPer1M`),
    };
    // Optional freshness metadata (schema_version >= 2); validated if present so a
    // malformed field is caught, but absent ⇒ the model simply has no family/order.
    if (raw.family !== undefined) {
      if (typeof raw.family !== 'string' || raw.family.trim() === '') {
        throw new PriceError(`models["${model}"].family must be a non-empty string when present.`);
      }
      entry.family = raw.family;
    }
    if (raw.released !== undefined) {
      if (typeof raw.released !== 'string' || Number.isNaN(Date.parse(raw.released))) {
        throw new PriceError(`models["${model}"].released must be an ISO date string when present.`);
      }
      entry.released = raw.released;
    }
    models[model] = entry;
  }
  if (!Object.hasOwn(models, data.frontier_model)) {
    throw new PriceError(
      `Price table frontier_model "${data.frontier_model}" has no entry in models.`,
    );
  }
  return { schema_version: data.schema_version, frontier_model: data.frontier_model, models };
}

function requireUsage(usage: Usage): void {
  for (const key of ['tokens_in', 'tokens_out'] as const) {
    const v = usage[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new PriceError(`usage.${key} must be a finite number >= 0 (got ${JSON.stringify(v)}).`);
    }
  }
}

/** List price (USD) to run `usage` on `model`. Throws if the model has no price. */
export function priceForModel(table: PriceTable, model: string, usage: Usage): number {
  requireUsage(usage);
  // Own-key lookup: never resolve a model id to an inherited prototype member.
  const p = Object.hasOwn(table.models, model) ? table.models[model] : undefined;
  if (!p) {
    throw new PriceError(`No price for model "${model}" in the price table.`);
  }
  return (usage.tokens_in / 1_000_000) * p.inputPer1M + (usage.tokens_out / 1_000_000) * p.outputPer1M;
}

/**
 * Compute the five cost primitives for one executed task.
 *
 * `actual_cost` is the lane's *marginal* cost: subscription and local lanes are
 * already paid flat-rate / run locally, so their marginal cash cost is 0; only
 * metered (API) lanes are priced. `frontier_cost` always prices the same tokens
 * at the frontier model, so it exists even for free lanes (and is the canonical
 * denominator persisted on every event).
 */
export function computeCostPrimitives(
  table: PriceTable,
  lane: { model: string; costBasis: CostBasis },
  usage: Usage,
): CostPrimitives {
  const frontier_cost = priceForModel(table, table.frontier_model, usage);
  const actual_cost = lane.costBasis === 'metered' ? priceForModel(table, lane.model, usage) : 0;
  const metered_spent = lane.costBasis === 'metered' ? actual_cost : 0;
  return {
    frontier_cost,
    actual_cost,
    metered_spent,
    frontier_avoided: frontier_cost - actual_cost,
    metered_avoided: frontier_cost - metered_spent,
  };
}

/**
 * Aggregate cost primitives into the canonical savings summary.
 *
 *   frontier_avoided_pct = 100 × Σ frontier_avoided / Σ frontier_cost
 *   metered_avoided_pct  = 100 × Σ metered_avoided  / Σ frontier_cost
 *
 * Guard: if Σ frontier_cost == 0, both percentages are 0 (never divide by zero).
 */
export function aggregateSavings(rows: readonly CostPrimitives[]): SavingsSummary {
  let frontier_cost = 0;
  let frontier_avoided = 0;
  let metered_spent = 0;
  let metered_avoided = 0;
  for (const r of rows) {
    frontier_cost += r.frontier_cost;
    frontier_avoided += r.frontier_avoided;
    metered_spent += r.metered_spent;
    metered_avoided += r.metered_avoided;
  }
  const pct = (numerator: number): number =>
    frontier_cost === 0 ? 0 : (100 * numerator) / frontier_cost;
  return {
    frontier_cost,
    frontier_avoided,
    metered_spent,
    metered_avoided,
    frontier_avoided_pct: pct(frontier_avoided),
    metered_avoided_pct: pct(metered_avoided),
  };
}

/** Cost forecast structure for pre-flight advisory display. */
export interface CostForecast {
  estTokensIn: number;
  estCostUsd?: number;
  basis: CostBasis;
  note: string;
}

/**
 * Pure cost forecasting for a given prompt/task before execution.
 * Labels the token count as an estimate and the cost as a projection.
 */
export function forecastCost(
  promptText: string,
  lane: { model: string; costBasis: CostBasis },
  priceTable?: PriceTable,
): CostForecast {
  let estTokensIn = 0;
  if (typeof promptText === 'string') {
    estTokensIn = estimateTokens(promptText);
  }
  if (typeof estTokensIn !== 'number' || !Number.isFinite(estTokensIn) || estTokensIn < 0) {
    estTokensIn = 0;
  }
  estTokensIn = Math.floor(estTokensIn);

  const basis = lane.costBasis;

  if (basis === 'subscription') {
    return {
      estTokensIn,
      estCostUsd: 0,
      basis,
      note: 'flat-rate subscription',
    };
  }

  if (basis === 'local') {
    return {
      estTokensIn,
      estCostUsd: 0,
      basis,
      note: 'local — no metered cost',
    };
  }

  // metered lane
  const missingNote = `missing price entry for model "${lane.model}" (price unavailable / output extra)`;

  if (!priceTable || !priceTable.models || !Object.hasOwn(priceTable.models, lane.model)) {
    return {
      estTokensIn,
      basis,
      note: missingNote,
    };
  }

  const price = priceTable.models[lane.model];
  if (!price || typeof price.inputPer1M !== 'number' || !Number.isFinite(price.inputPer1M) || price.inputPer1M < 0) {
    return {
      estTokensIn,
      basis,
      note: missingNote,
    };
  }

  const estCostUsd = (estTokensIn * price.inputPer1M) / 1_000_000;
  if (typeof estCostUsd !== 'number' || !Number.isFinite(estCostUsd) || estCostUsd < 0) {
    return {
      estTokensIn,
      basis,
      note: missingNote,
    };
  }

  return {
    estTokensIn,
    estCostUsd,
    basis,
    note: 'input only, output extra',
  };
}
