import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EVENT_FIELDS,
  OUTCOME_EVENT_FIELDS,
  SCHEMA_VERSION,
  filterEventsSince,
  LedgerError,
  outcomeStats,
  parseEvent,
  serializeEvent,
  summarize,
  tokenStats,
  validateEventInput,
  validateOutcomeInput,
} from '../src/ledger.ts';
import type { OutcomeEvent, TaskEvent } from '../src/ledger.ts';

function ev(overrides: Partial<TaskEvent> = {}): TaskEvent {
  const base: TaskEvent = {
    event_type: 'task',
    schema_version: SCHEMA_VERSION,
    id: 'id-0',
    seq: 0,
    ts: '2026-06-02T00:00:00.000Z',
    task_id: 't-0',
    attempt: 0,
    category: 'bugfix',
    laneId: 'codex-cli',
    model: 'gpt-5.5',
    trust_mode: 'full',
    provenance: 'openai',
    status: 'ok',
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
  // Keep avoided consistent with costs (as validateEventInput would derive them).
  return { ...base, frontier_avoided: base.frontier_cost - base.actual_cost, metered_avoided: base.frontier_cost - base.metered_spent };
}

function outcome(overrides: Partial<OutcomeEvent> = {}): OutcomeEvent {
  return {
    event_type: 'outcome',
    schema_version: SCHEMA_VERSION,
    id: 'o-0',
    seq: 0,
    ts: '2026-06-02T00:00:00.000Z',
    subject_id: 't-0',
    subject_type: 'router_task',
    task_id: 't-0',
    review_id: 'r-0',
    attempt: 0,
    category: 'bugfix',
    subject_lane_id: 'codex-cli',
    subject_provenance: 'openai',
    reviewer_lane_id: 'claude-native',
    reviewer_model: 'claude-opus-4-7',
    reviewer_trust_mode: 'full',
    reviewer_provenance: 'anthropic',
    verdict: 'pass',
    voter: 'reviewer_model',
    policy_verdict: 'allow',
    ...overrides,
  };
}

test('serializeEvent emits only allowlisted fields (no extras), incl. event discriminant', () => {
  const keys = Object.keys(JSON.parse(serializeEvent(ev())));
  const allow = new Set<string>(EVENT_FIELDS);
  for (const k of keys) assert.ok(allow.has(k), `unexpected field ${k}`);
  for (const required of ['event_type', 'schema_version', 'status', 'task_id']) {
    assert.ok(keys.includes(required), `missing ${required}`);
  }
});

test('outcome events round-trip and serialize within their allowlist', () => {
  const round = parseEvent(JSON.parse(serializeEvent(outcome())));
  assert.deepEqual(round, outcome());
  const keys = Object.keys(JSON.parse(serializeEvent(outcome())));
  const allow = new Set<string>(OUTCOME_EVENT_FIELDS);
  for (const k of keys) assert.ok(allow.has(k), `unexpected field ${k}`);
});

test('validateOutcomeInput rejects a bad verdict and a non-object subject', () => {
  assert.throws(() => validateOutcomeInput({ ...outcome(), verdict: 'great' as never }), { message: /verdict/ });
  assert.throws(() => validateOutcomeInput({ ...outcome(), subject_type: 'nope' as never }), { message: /subject_type/ });
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

test('summarize: savings count only ok tasks; spend includes all; blockCount by status', () => {
  const events = [
    ev({ laneId: 'A', status: 'ok', frontier_cost: 100, actual_cost: 0, metered_spent: 0 }),
    ev({ laneId: 'B', status: 'ok', frontier_cost: 100, actual_cost: 40, metered_spent: 40 }),
    ev({ laneId: 'B', status: 'blocked', frontier_cost: 0, actual_cost: 0, metered_spent: 0 }),
  ];
  const s = summarize(events);
  assert.equal(s.events, 3);
  assert.equal(s.actual_cost, 40);
  assert.equal(s.metered_spent_total, 40);
  assert.equal(s.blockCount, 1);
  assert.deepEqual({ ...s.laneMix }, { A: 1, B: 2 });
  // Savings over the two ok tasks only.
  assert.equal(s.savings.frontier_cost, 200);
  assert.equal(s.savings.frontier_avoided_pct, 80);
  assert.equal(s.savings.metered_avoided_pct, 80);
});

test('summarize: a failed worker attempt costs money but is excluded from savings claims', () => {
  const events = [
    // A failed metered attempt: real spend, but not counted as avoided savings.
    ev({ laneId: 'W', status: 'failed', frontier_cost: 100, actual_cost: 30, metered_spent: 30 }),
    // The successful trusted fallback (linked by parent_task_id): savings count this.
    ev({ laneId: 'T', status: 'ok', parent_task_id: 't-0', frontier_cost: 100, actual_cost: 0, metered_spent: 0 }),
  ];
  const s = summarize(events);
  assert.equal(s.actual_cost, 30); // failed attempt's spend is real
  assert.equal(s.metered_spent_total, 30);
  // Baseline is the delivered (ok) work (100); avoided subtracts ALL spend (30).
  assert.equal(s.savings.frontier_cost, 100);
  assert.equal(s.savings.frontier_avoided, 70);
  assert.equal(s.savings.metered_avoided, 70);
  assert.equal(s.savings.frontier_avoided_pct, 70);
});

test('parseEvent reads a legacy task row (no event_type/new fields) by backfilling', () => {
  // A row as written by the pre-union schema.
  const legacy = {
    id: 'legacy-1',
    seq: 0,
    ts: '2026-06-01T00:00:00.000Z',
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
  };
  const e = parseEvent(legacy);
  assert.equal(e.event_type, 'task');
  assert.equal(e.schema_version, 0); // legacy
  if (e.event_type === 'task') {
    assert.equal(e.task_id, 'legacy-1'); // backfilled from id
    assert.equal(e.status, 'ok');
    assert.equal(e.trust_mode, 'full');
    assert.equal(e.provenance, 'unknown');
  }
  // A legacy row with a block verdict backfills to status 'blocked' (preserves blockCount).
  const blockedLegacy = parseEvent({ ...legacy, id: 'legacy-2', policy_verdict: 'block' });
  assert.equal(blockedLegacy.event_type === 'task' && blockedLegacy.status, 'blocked');
});

test('summarize over no events is all zeros (no divide-by-zero)', () => {
  const s = summarize([]);
  assert.equal(s.events, 0);
  assert.equal(s.savings.frontier_avoided_pct, 0);
  assert.deepEqual({ ...s.laneMix }, {});
});

test('outcomeStats tallies verdicts per reviewed lane with the dogfood success rate', () => {
  const events = [
    ev(), // a task event — ignored by outcomeStats
    outcome({ subject_lane_id: 'worker-a', verdict: 'pass' }),
    outcome({ subject_lane_id: 'worker-a', verdict: 'needs-rework' }),
    outcome({ subject_lane_id: 'worker-a', verdict: 'fail' }),
    outcome({ subject_type: 'host_turn', task_id: undefined, turn_id: 'turn-1', subject_lane_id: undefined, verdict: 'pass' }),
  ];
  const s = outcomeStats(events);
  assert.equal(s.total.total, 4);
  assert.equal(s.total.pass, 2);
  assert.equal(s.total.needs_rework, 1);
  assert.equal(s.total.fail, 1);
  // worker-a: (1 pass + 0.5*1 rework) / 3 = 0.5
  assert.equal(s.byLane['worker-a']?.success_rate, 0.5);
  // host-turn review buckets under (host).
  assert.equal(s.byLane['(host)']?.pass, 1);
  // A router_task review with no subject lane is unattributed, NOT host.
  const withUnattributed = outcomeStats([outcome({ subject_lane_id: undefined, verdict: 'fail' })]);
  assert.equal(withUnattributed.byLane['(unattributed)']?.fail, 1);
  assert.equal(withUnattributed.byLane['(host)'], undefined);
});

// --- C-13 E-2: escalation telemetry -------------------------------------------

test('validateOutcomeInput accepts + validates action_taken/target_lane_id', () => {
  const v = validateOutcomeInput({ ...outcome(), action_taken: 'escalate', target_lane_id: 'strong' });
  assert.equal(v.action_taken, 'escalate');
  assert.equal(v.target_lane_id, 'strong');
  // omitted ⇒ absent (legacy rows stay valid)
  const none = validateOutcomeInput(outcome());
  assert.equal(none.action_taken, undefined);
  assert.equal(none.target_lane_id, undefined);
  // bad action rejected
  assert.throws(() => validateOutcomeInput({ ...outcome(), action_taken: 'nope' as never }), { message: /action_taken/ });
});

test('serializeEvent includes action_taken/target_lane_id only when present (content-free)', () => {
  const withAction = JSON.parse(serializeEvent(outcome({ action_taken: 'escalate', target_lane_id: 'strong' })));
  assert.equal(withAction.action_taken, 'escalate');
  assert.equal(withAction.target_lane_id, 'strong');
  const without = JSON.parse(serializeEvent(outcome()));
  assert.ok(!('action_taken' in without));
  assert.ok(!('target_lane_id' in without));
});

test('outcomeStats: per-offload escalation rate by distinct task_id (host-turn never dilutes)', () => {
  const events = [
    // offload t-1: initial needs-rework (rework) then escalate ⇒ counts once as escalated.
    outcome({ task_id: 't-1', subject_id: 't-1', verdict: 'needs-rework', action_taken: 'rework' }),
    outcome({ task_id: 't-1', subject_id: 't-1', verdict: 'fail', action_taken: 'escalate', target_lane_id: 'strong' }),
    // offload t-2: accepted, never escalated.
    outcome({ task_id: 't-2', subject_id: 't-2', verdict: 'pass', action_taken: 'accept' }),
    // a host-turn review must NOT count toward the offload denominator.
    outcome({ subject_type: 'host_turn', task_id: undefined, turn_id: 'turn-1', subject_lane_id: undefined, verdict: 'fail' }),
  ];
  const s = outcomeStats(events);
  assert.equal(s.escalation.offloadsReviewed, 2); // t-1, t-2 (not the host turn)
  assert.equal(s.escalation.escalated, 1); // t-1
  assert.equal(s.escalation.rate, 0.5);
});

test('outcomeStats: escalation rate is 0 with no router-task reviews', () => {
  const s = outcomeStats([outcome({ subject_type: 'host_turn', task_id: undefined, turn_id: 'x', subject_lane_id: undefined })]);
  assert.equal(s.escalation.offloadsReviewed, 0);
  assert.equal(s.escalation.rate, 0);
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
