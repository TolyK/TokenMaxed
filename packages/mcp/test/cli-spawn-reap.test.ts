/**
 * makeCliSpawn process-GROUP reap: a reviewer/worker CLI (codex, claude, …) can
 * fork a long-lived listener/app-server/event-loop that outlives the one-shot
 * call; left unreaped they accumulate and exhaust spawn capacity. The spawn runs
 * the child detached (own group) and SIGKILLs the group after — so nothing it
 * spawned survives. This is an integration test (real `sh`, posix groups).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { makeCliSpawn } from '../src/config.ts';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('makeCliSpawn reaps a lingering background child (no listener outlives the call)', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-reap-'));
  const pidFile = join(dir, 'child.pid');
  const spawn = makeCliSpawn(10_000);
  // `sh` backgrounds a long sleep (stand-in for a leaked codex listener), records its
  // pid, then exits. After makeCliSpawn returns, the group reap must have killed the sleep.
  // Pass pidFile as an ARGV element ($1), never interpolated into the script — so a
  // TMPDIR with spaces/quotes/metacharacters can't break or inject shell syntax.
  // The sleep redirects its stdio (`>/dev/null 2>&1`) so it does NOT hold our stdout
  // pipe — modelling a real detached listener (e.g. codex's app-server), so spawnSync
  // returns promptly and the reap is what kills it (not the timeout). A child that
  // KEEPS the pipe is the separate, timeout-bounded residual documented in config.ts.
  const res = spawn('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $! > "$1"; echo ok', 'sh', pidFile], {
    input: '',
    encoding: 'utf8',
    maxBuffer: 1 << 20,
  });
  assert.match(res.stdout ?? '', /ok/, 'the CLI itself ran to completion');
  // The clean one-shot must return NORMALLY (not via the spawn timeout): the
  // backgrounded child detaches our stdio, so spawnSync isn't kept blocked on the
  // pipe. A regression that let a leak hold stdout would surface as ETIMEDOUT here.
  assert.equal(res.error, undefined, 'returned normally, not via timeout (ETIMEDOUT)');
  assert.ok(existsSync(pidFile), 'child recorded its pid');
  const childPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  assert.ok(Number.isInteger(childPid) && childPid > 0, 'valid child pid');

  // SIGKILL delivery + init-reparent reaping is async; poll briefly.
  let waited = 0;
  while (alive(childPid) && waited < 2000) {
    await new Promise((r) => setTimeout(r, 50));
    waited += 50;
  }
  assert.equal(alive(childPid), false, `backgrounded child ${childPid} must be reaped, not left running`);
});
