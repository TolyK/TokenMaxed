/**
 * Regenerate data/known-models.json — the server-side trusted model catalog —
 * from config/prices.seed.json ∪ the starter lanes' model labels. Run from
 * web/: `node generate-catalog.mjs`. Pinned by packages/cli/test/share.test.ts
 * (the committed catalog must stay a superset of the price table's ids).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const prices = JSON.parse(readFileSync(resolve(root, '../config/prices.seed.json'), 'utf8'));
const lanes = readFileSync(resolve(root, '../packages/mcp/lanes.starter.yaml'), 'utf8');
const models = new Set(Object.keys(prices.models));
for (const m of lanes.matchAll(/model:\s*([A-Za-z0-9._@/:-]+)/g)) models.add(m[1]);
writeFileSync(
  resolve(root, 'data/known-models.json'),
  JSON.stringify({ generated: new Date().toISOString().slice(0, 10), models: [...models].sort() }, null, 2) + '\n',
);
console.error(`known-models.json: ${models.size} models`);
