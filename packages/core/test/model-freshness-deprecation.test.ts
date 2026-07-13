import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePriceTable, PriceError } from '../src/price.ts';
import { assessDeprecation, resolveDeprecatedModel } from '../src/model-freshness.ts';
import type { PriceTable } from '../src/price.ts';

test('schema 1/2 + field-less user tables still load (backward-compatible)', () => {
  const schema1 = {
    schema_version: 1,
    frontier_model: 'opus',
    models: {
      opus: { inputPer1M: 15, outputPer1M: 75 }
    }
  };
  const schema2 = {
    schema_version: 2,
    frontier_model: 'opus',
    models: {
      opus: { inputPer1M: 15, outputPer1M: 75, family: 'cl', released: '2026-01-01' }
    }
  };
  assert.ok(validatePriceTable(schema1));
  assert.ok(validatePriceTable(schema2));
});

test('new fields validated (reject wrong types)', () => {
  const badDeprecated = {
    schema_version: 3,
    frontier_model: 'opus',
    models: {
      opus: { inputPer1M: 15, outputPer1M: 75, deprecated: "yes" }
    }
  };
  const badFrom = {
    schema_version: 3,
    frontier_model: 'opus',
    models: {
      opus: { inputPer1M: 15, outputPer1M: 75, deprecated: true, deprecated_from: 12345 }
    }
  };
  const badSuccessor = {
    schema_version: 3,
    frontier_model: 'opus',
    models: {
      opus: { inputPer1M: 15, outputPer1M: 75, deprecated: true, successor: {} }
    }
  };

  assert.throws(() => validatePriceTable(badDeprecated), PriceError);
  assert.throws(() => validatePriceTable(badFrom), PriceError);
  assert.throws(() => validatePriceTable(badSuccessor), PriceError);
});

test('assessDeprecation for ok / deprecated-now / deprecated_from-in-future / successor-priced vs successor-unpriced', () => {
  const table: PriceTable = {
    schema_version: 3,
    frontier_model: 'live',
    models: {
      live: { inputPer1M: 1, outputPer1M: 1 },
      old: {
        inputPer1M: 1,
        outputPer1M: 1,
        deprecated: true,
        deprecated_from: '2026-07-01',
        successor: 'live'
      },
      future: {
        inputPer1M: 1,
        outputPer1M: 1,
        deprecated: true,
        deprecated_from: '2026-08-01',
        successor: 'live'
      },
      noSuccessor: {
        inputPer1M: 1,
        outputPer1M: 1,
        deprecated: true,
      },
      unpricedSuccessor: {
        inputPer1M: 1,
        outputPer1M: 1,
        deprecated: true,
        successor: 'absent-model'
      }
    }
  };

  const now = Date.parse('2026-07-15');

  // ok (live model)
  assert.deepEqual(assessDeprecation('live', table, now), { status: 'ok' });

  // deprecated-now
  assert.deepEqual(assessDeprecation('old', table, now), {
    status: 'deprecated',
    from: '2026-07-01',
    successor: 'live',
    successorUsable: true
  });

  // deprecated_from-in-future (=ok)
  assert.deepEqual(assessDeprecation('future', table, now), { status: 'ok' });

  // no successor
  assert.deepEqual(assessDeprecation('noSuccessor', table, now), {
    status: 'deprecated',
    from: undefined,
    successor: undefined,
    successorUsable: false
  });

  // unpriced successor
  assert.deepEqual(assessDeprecation('unpricedSuccessor', table, now), {
    status: 'deprecated',
    from: undefined,
    successor: 'absent-model',
    successorUsable: false
  });
});

test('resolveDeprecatedModel migrates only to priced+present successor, leaves unchanged otherwise', () => {
  const table: PriceTable = {
    schema_version: 3,
    frontier_model: 'live',
    models: {
      live: { inputPer1M: 1, outputPer1M: 1 },
      old: { inputPer1M: 1, outputPer1M: 1, deprecated: true, successor: 'live' },
      noPriceSuccessor: { inputPer1M: 1, outputPer1M: 1, deprecated: true, successor: 'absent' },
      selfLoop: { inputPer1M: 1, outputPer1M: 1, deprecated: true, successor: 'selfLoop' }
    }
  };

  const lane = { id: 'test-lane', model: 'old' };
  const now = Date.now();

  // Valid migration
  const res1 = resolveDeprecatedModel(lane, table, now);
  assert.equal(res1.lane.model, 'live');
  assert.equal(res1.migratedFrom, 'old');
  assert.match(res1.warning || '', /deprecated.*auto-migrated/);

  // Absent successor stays unchanged
  const res2 = resolveDeprecatedModel({ id: 'test-lane', model: 'noPriceSuccessor' }, table, now);
  assert.equal(res2.lane.model, 'noPriceSuccessor');
  assert.equal(res2.migratedFrom, undefined);

  // Self-loop stays unchanged
  const res3 = resolveDeprecatedModel({ id: 'test-lane', model: 'selfLoop' }, table, now);
  assert.equal(res3.lane.model, 'selfLoop');
  assert.equal(res3.migratedFrom, undefined);
});

test('resolveDeprecatedModel cycle safety A->B->A', () => {
  const table: PriceTable = {
    schema_version: 3,
    frontier_model: 'opus',
    models: {
      opus: { inputPer1M: 1, outputPer1M: 1 },
      modelA: { inputPer1M: 1, outputPer1M: 1, deprecated: true, successor: 'modelB' },
      modelB: { inputPer1M: 1, outputPer1M: 1, deprecated: true, successor: 'modelA' }
    }
  };
  const lane = { id: 'test-lane', model: 'modelA' };
  const now = Date.now();
  const res = resolveDeprecatedModel(lane, table, now);
  assert.equal(res.lane.model, 'modelA', 'A->B->A cycle leaves model unchanged');
  assert.equal(res.migratedFrom, undefined);
});

test('resolveDeprecatedModel refuses to migrate to a successor with an @latest alias', () => {
  const table: PriceTable = {
    schema_version: 3,
    frontier_model: 'live',
    models: {
      live: { inputPer1M: 1, outputPer1M: 1 },
      old: { inputPer1M: 1, outputPer1M: 1, deprecated: true, successor: 'live@latest' }
    }
  };
  const lane = { id: 'test-lane', model: 'old' };
  const res = resolveDeprecatedModel(lane, table, Date.now());
  assert.equal(res.lane.model, 'old', 'Should refuse migration to @latest alias');
  assert.equal(res.migratedFrom, undefined);
});

test('validatePriceTable returns byte-identical output for schema 1/2 and field-less tables', () => {
  const schema1 = {
    schema_version: 1,
    frontier_model: 'opus',
    models: {
      opus: { inputPer1M: 15, outputPer1M: 75 }
    }
  };
  const validated1 = validatePriceTable(schema1);
  assert.equal(JSON.stringify(validated1), JSON.stringify(schema1));

  const schema2 = {
    schema_version: 2,
    frontier_model: 'opus',
    models: {
      opus: { inputPer1M: 15, outputPer1M: 75, family: 'cl', released: '2026-01-01' }
    }
  };
  const validated2 = validatePriceTable(schema2);
  assert.equal(JSON.stringify(validated2), JSON.stringify(schema2));
});

test('validatePriceTable rejects invalid/impossible deprecation dates', () => {
  const badDateTable = {
    schema_version: 3,
    frontier_model: 'opus',
    models: {
      opus: { inputPer1M: 15, outputPer1M: 75, deprecated: true, deprecated_from: '2026-02-30' }
    }
  };
  assert.throws(() => validatePriceTable(badDateTable), PriceError);

  const badNonIsoTable = {
    schema_version: 3,
    frontier_model: 'opus',
    models: {
      opus: { inputPer1M: 15, outputPer1M: 75, deprecated: true, deprecated_from: 'July 1, 2026' }
    }
  };
  assert.throws(() => validatePriceTable(badNonIsoTable), PriceError);
});

test('resolveDeprecatedModel single-hop behavior A->B->C (B is deprecated)', () => {
  const table: PriceTable = {
    schema_version: 3,
    frontier_model: 'opus',
    models: {
      opus: { inputPer1M: 1, outputPer1M: 1 },
      modelA: { inputPer1M: 1, outputPer1M: 1, deprecated: true, successor: 'modelB' },
      modelB: { inputPer1M: 1, outputPer1M: 1, deprecated: true, successor: 'opus' }
    }
  };
  const lane = { id: 'test-lane', model: 'modelA' };
  const now = Date.now();
  const res = resolveDeprecatedModel(lane, table, now);
  assert.equal(res.lane.model, 'modelA', 'A->B (where B is deprecated) should leave A unchanged');
  assert.equal(res.migratedFrom, undefined);
});

test('assessDeprecation and resolveDeprecatedModel behavior when now is NaN/non-finite', () => {
  const table: PriceTable = {
    schema_version: 3,
    frontier_model: 'opus',
    models: {
      opus: { inputPer1M: 1, outputPer1M: 1 },
      old: { inputPer1M: 1, outputPer1M: 1, deprecated: true, successor: 'opus' },
      future: { inputPer1M: 1, outputPer1M: 1, deprecated: true, deprecated_from: '2026-08-01', successor: 'opus' }
    }
  };
  const lane = { id: 'test-lane', model: 'old' };
  const res = resolveDeprecatedModel(lane, table, NaN);
  assert.equal(res.lane.model, 'old', 'NaN now leaves lane unchanged');
  assert.equal(res.migratedFrom, undefined);

  const report1 = assessDeprecation('old', table, NaN);
  assert.deepEqual(report1, { status: 'ok' }, 'NaN now makes assessDeprecation treat model as ok');

  const report2 = assessDeprecation('future', table, NaN);
  assert.deepEqual(report2, { status: 'ok' }, 'NaN now makes assessDeprecation treat future deprecation as ok');
});

test('resolveDeprecatedModel structural cycle safety A->B->C->A where B is non-deprecated', () => {
  const table: PriceTable = {
    schema_version: 3,
    frontier_model: 'opus',
    models: {
      opus: { inputPer1M: 1, outputPer1M: 1 },
      modelA: { inputPer1M: 1, outputPer1M: 1, deprecated: true, successor: 'modelB' },
      modelB: { inputPer1M: 1, outputPer1M: 1, successor: 'modelC' },
      modelC: { inputPer1M: 1, outputPer1M: 1, successor: 'modelA' }
    }
  };
  const lane = { id: 'test-lane', model: 'modelA' };
  const now = Date.now();
  const res = resolveDeprecatedModel(lane, table, now);
  assert.equal(res.lane.model, 'modelA', 'A->B->C->A cycle where B is non-deprecated refuses migration');
  assert.equal(res.migratedFrom, undefined);

  const report = assessDeprecation('modelA', table, now);
  assert.equal(report.status, 'deprecated');
  assert.equal(report.successor, 'modelB');
  assert.equal(report.successorUsable, false, 'successor modelB on cycle back to origin is unusable');
});
