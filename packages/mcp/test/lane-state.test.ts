/**
 * Tests for the pure lane-review fingerprint + versioned state (SETUP-1 B): order
 * sensitivity, executor/destination field coverage, canonical serialization, and the
 * state coerce/isChanged/markSeen helpers.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  coerceLaneReviewState,
  emptyLaneReviewState,
  isLanesChanged,
  laneSetFingerprint,
  markLanesSeen,
  readLaneReviewState,
  writeLaneReviewState,
} from '../src/lane-state.ts';
import type { Lane } from '@tokenmaxed/core';

const lane = (over: Partial<Lane> & { id: string }): Lane => ({
  kind: 'cli', model: 'm', trust_mode: 'full', costBasis: 'subscription',
  provenance: 'anthropic', jurisdiction: 'US', ...over,
});

const A = lane({ id: 'a', capability: { docs: 0.8 } });
const B = lane({ id: 'b', kind: 'api', trust_mode: 'worker', endpoint: 'https://x', authHandle: 'K' });

test('fingerprint is stable for identical config and order', () => {
  assert.equal(laneSetFingerprint([A, B]), laneSetFingerprint([A, B]));
});

test('fingerprint is ORDER-sensitive (lane order decides the active reviewer)', () => {
  assert.notEqual(laneSetFingerprint([A, B]), laneSetFingerprint([B, A]));
});

test('fingerprint changes on any covered field — incl. executor/destination fields', () => {
  const base = laneSetFingerprint([B]);
  assert.notEqual(base, laneSetFingerprint([{ ...B, endpoint: 'https://y' }])); // destination
  assert.notEqual(base, laneSetFingerprint([{ ...B, authHandle: 'K2' }])); // key handle
  assert.notEqual(base, laneSetFingerprint([{ ...B, trust_mode: 'reader' }])); // permission
  assert.notEqual(base, laneSetFingerprint([{ ...B, model: 'm2' }])); // raw model
  const cli = lane({ id: 'c', command: 'codex', args: ['exec'] });
  assert.notEqual(laneSetFingerprint([cli]), laneSetFingerprint([{ ...cli, command: 'gemini' }])); // command
  assert.notEqual(laneSetFingerprint([cli]), laneSetFingerprint([{ ...cli, args: ['code'] }])); // args
});

test('fingerprint is canonical: insensitive to capability KEY order, sensitive to ARGS order', () => {
  const c1 = lane({ id: 'a', capability: { docs: 0.8, bugfix: 0.6 } });
  const c2 = lane({ id: 'a', capability: { bugfix: 0.6, docs: 0.8 } });
  assert.equal(laneSetFingerprint([c1]), laneSetFingerprint([c2])); // capability key order ignored
  const x = lane({ id: 'x', command: 'k', args: ['a', 'b'] });
  const y = lane({ id: 'x', command: 'k', args: ['b', 'a'] });
  assert.notEqual(laneSetFingerprint([x]), laneSetFingerprint([y])); // arg ORDER preserved
});

test('isLanesChanged: true when unseen or different; false when matching', () => {
  const fp = laneSetFingerprint([A]);
  let s = emptyLaneReviewState();
  assert.equal(isLanesChanged(s, 'p', fp), true); // never seen
  s = markLanesSeen(s, 'p', fp);
  assert.equal(isLanesChanged(s, 'p', fp), false); // seen, same
  assert.equal(isLanesChanged(s, 'p', laneSetFingerprint([A, B])), true); // config changed
  assert.equal(isLanesChanged(s, 'other-project', fp), true); // per-project
});

test('markLanesSeen does not mutate the input and is per-project', () => {
  const s0 = emptyLaneReviewState();
  const s1 = markLanesSeen(s0, 'p', 'fp1');
  assert.equal(isLanesChanged(s0, 'p', 'fp1'), true); // original untouched
  const s2 = markLanesSeen(s1, 'q', 'fp2');
  assert.equal(isLanesChanged(s2, 'p', 'fp1'), false);
  assert.equal(isLanesChanged(s2, 'q', 'fp2'), false);
});

test('coerceLaneReviewState drops wrong version / malformed entries', () => {
  assert.deepEqual({ ...coerceLaneReviewState({ version: 9, byProject: { p: { fingerprint: 'x' } } }).byProject }, {});
  assert.deepEqual({ ...coerceLaneReviewState('nope').byProject }, {});
  const ok = coerceLaneReviewState({ version: 1, byProject: { p: { fingerprint: 'x' }, bad: { nope: 1 } } });
  assert.deepEqual({ ...ok.byProject }, { p: { fingerprint: 'x' } });
});

test('read/write round-trips through a file; missing ⇒ empty', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tm-lanestate-')), 'sub', 'lane-review.json');
  assert.deepEqual({ ...readLaneReviewState(path).byProject }, {});
  writeLaneReviewState(path, markLanesSeen(emptyLaneReviewState(), 'p', 'fp1'));
  assert.equal(isLanesChanged(readLaneReviewState(path), 'p', 'fp1'), false);
});
