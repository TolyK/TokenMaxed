/**
 * The trusted model catalog — the server-side membership boundary for
 * row.model. Regenerate data/known-models.json from config/prices.seed.json
 * (+ starter lane models) whenever the price table gains models; a model not
 * listed here is rejected at submission and dropped at merge.
 */

import catalog from '../data/known-models.json' with { type: 'json' };

export const KNOWN_MODELS: ReadonlySet<string> = new Set<string>(catalog.models);
