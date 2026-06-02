import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  alertsCrossed,
  capHeadroom,
  capLevel,
  capUsedFraction,
  estimateTokens,
  resolveUsage,
  UsageError,
} from '../src/usage.ts';

test('estimateTokens approximates ~4 chars per token; empty is 0', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2); // ceil(5/4)
  assert.equal(estimateTokens('a'.repeat(400)), 100);
});

test('resolveUsage uses reported usage and marks it not estimated', () => {
  const u = resolveUsage({ reported: { tokens_in: 100, tokens_out: 50 } });
  assert.deepEqual(u, { tokens_in: 100, tokens_out: 50, tokens_estimated: false });
});

test('resolveUsage folds cache tokens into tokens_in (no cache-savings claim)', () => {
  const u = resolveUsage({
    reported: {
      tokens_in: 100,
      tokens_out: 50,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 20,
    },
  });
  assert.equal(u.tokens_in, 150); // 100 + 30 + 20
  assert.equal(u.tokens_out, 50);
  assert.equal(u.tokens_estimated, false);
});

test('resolveUsage estimates from text when usage is not reported', () => {
  const u = resolveUsage({ promptText: 'a'.repeat(40), resultText: 'b'.repeat(80) });
  assert.deepEqual(u, { tokens_in: 10, tokens_out: 20, tokens_estimated: true });
});

test('resolveUsage estimates when only one of in/out is reported', () => {
  const u = resolveUsage({ reported: { tokens_in: 100 }, promptText: 'abcd', resultText: 'abcd' });
  assert.equal(u.tokens_estimated, true);
});

test('resolveUsage rejects invalid reported counts', () => {
  assert.throws(
    () => resolveUsage({ reported: { tokens_in: -1, tokens_out: 0 } }),
    UsageError,
  );
  assert.throws(
    () => resolveUsage({ reported: { tokens_in: 1.5, tokens_out: 0 } }),
    UsageError,
  );
});

test('capUsedFraction and capHeadroom complement each other; no cap ⇒ free', () => {
  assert.equal(capUsedFraction(700, 1000), 0.7);
  assert.ok(Math.abs(capHeadroom(700, 1000) - 0.3) < 1e-9); // 1 - 0.7
  // No cap configured.
  assert.equal(capUsedFraction(500, 0), 0);
  assert.equal(capHeadroom(500, 0), 1);
  // Over cap clamps headroom to 0.
  assert.equal(capHeadroom(1500, 1000), 0);
});

test('capLevel classifies ok / warn / critical at the thresholds', () => {
  assert.equal(capLevel(0.5), 'ok');
  assert.equal(capLevel(0.69), 'ok');
  assert.equal(capLevel(0.7), 'warn');
  assert.equal(capLevel(0.89), 'warn');
  assert.equal(capLevel(0.9), 'critical');
  assert.equal(capLevel(1.2), 'critical');
});

test('alertsCrossed fires each threshold exactly once across its crossing', () => {
  assert.deepEqual(alertsCrossed(0.5, 0.6), []);
  assert.deepEqual(alertsCrossed(0.65, 0.72), ['warn']);
  // Re-evaluating after already past warn does not re-fire it.
  assert.deepEqual(alertsCrossed(0.72, 0.8), []);
  // Crossing both in one jump fires both.
  assert.deepEqual(alertsCrossed(0.5, 0.95), ['warn', 'critical']);
  // Crossing only critical (already past warn).
  assert.deepEqual(alertsCrossed(0.8, 0.95), ['critical']);
});
