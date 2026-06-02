import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EVENT_FIELDS,
  filterEventsSince,
  LedgerError,
  parseEvent,
  serializeEvent,
  summarize,
  tokenStats,
  validateEventInput,
} from '../src/ledger.ts';
import type { TaskEvent } from '../src/ledger.ts';

function ev(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    id: 'id-0',
    seq: 0,
    ts: '2026-06-02T00:00:00.000Z',
    category: 'bugfix',
    laneId: 'codex-cli',
    model: 'gpt-5.5',
    tokens_in: 100,
    tokens_out: 50,
    tokens_estimated: false,
    actual_cost: 0,
    frontier_cost: 1,
    metered_spent: 0,
    frontier_avoided: 1,
    metered_avoided: 1,
    policy_verdict: 'allow',
    ...overrides,
  };
}

test('serializeEvent emits exactly the allowlisted fields, in order', () => {
  const line = serializeEvent(ev());
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [...EVENT_FIELDS]);
});

test('serializeEvent drops any non-allowlisted field (content can never leak)', () => {
  const sneaky = ev() as TaskEvent & { prompt?: string; codeSnippet?: string };
  sneaky.prompt = 'secret prompt text';
  sneaky.codeSnippet = 'const apiKey = "..."';
  const parsed = JSON.parse(serializeEvent(sneaky)) as Record<string, unknown>;
  assert.equal(parsed.prompt, undefined);
  assert.equal(parsed.codeSnippet, undefined);
  // No field name resembles content.
  for (const key of Object.keys(parsed)) {
    assert.doesNotMatch(key, /prompt|content|code|payload|snippet|text|path|repo|diff|secret/i);
  }
});

test('parseEvent round-trips a serialized event', () => {
  const original = ev({ id: 'abc', seq: 7, tokens_estimated: true });
  const round = parseEvent(JSON.parse(serializeEvent(original)));
  assert.deepEqual(round, original);
});

test('validateEventInput rejects bad inputs with clear errors', () => {
  const base = ev();
  assert.throws(() => validateEventInput({ ...base, tokens_in: -1 }), { message: /tokens_in/ });
  assert.throws(() => validateEventInput({ ...base, tokens_out: 1.5 }), { message: /tokens_out/ });
  assert.throws(
    () => validateEventInput({ ...base, tokens_estimated: 'yes' as unknown as boolean }),
    { message: /tokens_estimated/ },
  );
  assert.throws(
    () => validateEventInput({ ...base, policy_verdict: 'maybe' as unknown as TaskEvent['policy_verdict'] }),
    { message: /policy_verdict/ },
  );
  assert.throws(
    () => validateEventInput({ ...base, category: 'nope' as unknown as TaskEvent['category'] }),
    { message: /category/ },
  );
  assert.throws(
    () => validateEventInput({ ...base, frontier_cost: Number.POSITIVE_INFINITY }),
    { message: /frontier_cost/ },
  );
});

test('validateEventInput rejects negative costs and derives avoided canonically', () => {
  const base = ev();
  for (const field of ['actual_cost', 'frontier_cost', 'metered_spent'] as const) {
    assert.throws(() => validateEventInput({ ...base, [field]: -5 }), {
      message: new RegExp(`${field} must be a finite number >= 0`),
    });
  }
  // Avoided is derived from costs, so inconsistent inputs cannot be persisted:
  // a lane costing more than frontier (5 > 1) yields negative avoided.
  const ok = validateEventInput({
    ...base,
    frontier_cost: 1,
    actual_cost: 5,
    metered_spent: 5,
    frontier_avoided: 999, // ignored — derived as 1 - 5
    metered_avoided: 999, // ignored — derived as 1 - 5
  });
  assert.equal(ok.frontier_avoided, -4);
  assert.equal(ok.metered_avoided, -4);
});

test('parseEvent rejects a non-object and a missing id', () => {
  assert.throws(() => parseEvent('x'), { name: 'LedgerError', message: /must be a JSON object/ });
  const { id: _omit, ...noId } = ev();
  assert.throws(() => parseEvent(noId), LedgerError);
});

test('parseEvent rejects a malformed (unparseable) timestamp', () => {
  const good = JSON.parse(serializeEvent(ev())) as Record<string, unknown>;
  assert.throws(() => parseEvent({ ...good, ts: 'not-a-date' }), {
    name: 'LedgerError',
    message: /valid ISO-8601 timestamp/,
  });
});

test('filterEventsSince keeps events at or after the cutoff', () => {
  const events = [
    ev({ ts: '2026-06-01T00:00:00.000Z' }),
    ev({ ts: '2026-06-02T00:00:00.000Z' }),
    ev({ ts: '2026-06-03T00:00:00.000Z' }),
  ];
  assert.equal(filterEventsSince(events).length, 3);
  assert.equal(filterEventsSince(events, '2026-06-02T00:00:00.000Z').length, 2);
  assert.equal(filterEventsSince(events, '2026-06-04T00:00:00.000Z').length, 0);
});

test('filterEventsSince compares instants, not text (non-canonical ISO cutoffs work)', () => {
  const events = [ev({ ts: '2026-06-02T00:00:00.500Z' })];
  // No milliseconds: lexicographically '.500Z' < 'Z' would wrongly drop it.
  assert.equal(filterEventsSince(events, '2026-06-02T00:00:00Z').length, 1);
  // Equivalent instant expressed as a timezone offset.
  assert.equal(filterEventsSince(events, '2026-06-01T20:00:00-04:00').length, 1);
  // A cutoff just after the event drops it.
  assert.equal(filterEventsSince(events, '2026-06-02T00:00:01Z').length, 0);
  assert.throws(() => filterEventsSince(events, 'not-a-date'), {
    name: 'LedgerError',
    message: /invalid ISO timestamp/,
  });
});

test('summarize reports dollars, percentages, lane mix, and block count', () => {
  const events = [
    ev({ laneId: 'A', frontier_cost: 100, actual_cost: 0, metered_spent: 0, frontier_avoided: 100, metered_avoided: 100 }),
    ev({ laneId: 'B', frontier_cost: 100, actual_cost: 40, metered_spent: 40, frontier_avoided: 60, metered_avoided: 60 }),
    ev({ laneId: 'B', frontier_cost: 0, actual_cost: 0, metered_spent: 0, frontier_avoided: 0, metered_avoided: 0, policy_verdict: 'block' }),
  ];
  const s = summarize(events);
  assert.equal(s.events, 3);
  assert.equal(s.actual_cost, 40);
  assert.equal(s.blockCount, 1);
  assert.deepEqual({ ...s.laneMix }, { A: 1, B: 2 });
  assert.equal(s.savings.frontier_cost, 200);
  assert.equal(s.savings.frontier_avoided_pct, 80);
  assert.equal(s.savings.metered_avoided_pct, 80);
});

test('summarize over no events is all zeros (no divide-by-zero)', () => {
  const s = summarize([]);
  assert.equal(s.events, 0);
  assert.equal(s.savings.frontier_avoided_pct, 0);
  assert.deepEqual({ ...s.laneMix }, {});
});

test('tokenStats: overall, per-model, per-lane with estimated/reported split', () => {
  const events = [
    ev({ model: 'gpt-5.5', laneId: 'codex-cli', tokens_in: 100, tokens_out: 50, tokens_estimated: false }),
    ev({ model: 'llama3.1:8b', laneId: 'ollama', tokens_in: 200, tokens_out: 0, tokens_estimated: true, actual_cost: 0 }),
    ev({ model: 'gpt-5.5', laneId: 'codex-cli', tokens_in: 10, tokens_out: 10, tokens_estimated: true }),
  ];
  const s = tokenStats(events);

  // Overall.
  assert.equal(s.total.in, 310);
  assert.equal(s.total.out, 60);
  assert.equal(s.total.total, 370);
  // estimated + reported partition the total exactly.
  assert.equal(s.total.estimated.total + s.total.reported.total, s.total.total);
  assert.equal(s.total.estimated.total, 220);
  assert.equal(s.total.reported.total, 150);

  // Per model.
  assert.deepEqual(s.byModel['gpt-5.5'], {
    in: 110, out: 60, total: 170,
    estimated: { in: 10, out: 10, total: 20 },
    reported: { in: 100, out: 50, total: 150 },
    events: 2,
  });
  assert.equal(s.byModel['llama3.1:8b']?.total, 200);
  assert.equal(s.byModel['llama3.1:8b']?.events, 1);

  // The $0 local lane still appears in byLane.
  assert.equal(s.byLane['ollama']?.total, 200);

  // Σ byModel == total, and Σ byLane == total.
  const sumModels = Object.values(s.byModel).reduce((n, g) => n + g.total, 0);
  const sumLanes = Object.values(s.byLane).reduce((n, g) => n + g.total, 0);
  assert.equal(sumModels, s.total.total);
  assert.equal(sumLanes, s.total.total);
});
