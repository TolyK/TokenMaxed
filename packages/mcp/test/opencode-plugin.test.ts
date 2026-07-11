/**
 * F2 — OpenCode plugin behavior: host-identity env threading (no process.env
 * mutation), the deny-by-throw routing gate (same decision + reason as the
 * other hosts), the once-per-session banner injection, and the session.idle
 * review mapping (rework prompts back into the session, bounded by the shared
 * loop counter; toast fallback when prompt-back fails).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PRETOOLUSE_DENY_REASON } from '../src/hook.ts';
import {
  OPENCODE_DELEGATE_TOOL,
  REWORK_PROMPT_PREFIX,
  TokenMaxed,
  delegateDenyReason,
  makeIdleReviewHandler,
  opencodePluginEnv,
} from '../src/opencode-plugin.ts';
import type { IdleReviewDeps, OpencodePluginInput } from '../src/opencode-plugin.ts';
import type { OpencodeReviewAction } from '../src/opencode-review-main.ts';

// --- env threading ---------------------------------------------------------------

test('opencodePluginEnv: defaults host=opencode + project=directory; explicit env wins; process env untouched', () => {
  const processEnv = { HOME: '/home/u' } as NodeJS.ProcessEnv;
  const env = opencodePluginEnv(processEnv, '/work/dir');
  assert.equal(env.TOKENMAXED_HOST, 'opencode');
  assert.equal(env.TOKENMAXED_PROJECT, '/work/dir');
  assert.equal(env.TOKENMAXED_PROJECT_DIR, '/work/dir'); // the REAL path for diff acquisition
  assert.equal(processEnv.TOKENMAXED_HOST, undefined); // never mutated

  const explicit = opencodePluginEnv({ TOKENMAXED_HOST: 'my-fork', TOKENMAXED_PROJECT: 'p' } as NodeJS.ProcessEnv, '/w');
  assert.equal(explicit.TOKENMAXED_HOST, 'my-fork');
  assert.equal(explicit.TOKENMAXED_PROJECT, 'p');
});

// --- the routing gate ---------------------------------------------------------------

function stateEnv(dir: string, enabled: boolean, over: Record<string, string> = {}): NodeJS.ProcessEnv {
  const statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ proj: enabled }), 'utf8');
  return { TOKENMAXED_STATE: statePath, TOKENMAXED_PROJECT: 'proj', ...over } as NodeJS.ProcessEnv;
}

test('delegateDenyReason: enabled ⇒ allow (null); project-off ⇒ the shared deny reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-oc-'));
  try {
    assert.equal(delegateDenyReason(stateEnv(dir, true)), null);
    assert.equal(delegateDenyReason(stateEnv(dir, false)), PRETOOLUSE_DENY_REASON);
    // Kill-switch beats an enabled project toggle.
    assert.equal(delegateDenyReason(stateEnv(dir, true, { TOKENMAXED_DISABLE: '1' })), PRETOOLUSE_DENY_REASON);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tool.execute.before: throws the deny reason for router_delegate only when routing is off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-oc-'));
  const savedState = process.env.TOKENMAXED_STATE;
  const savedProject = process.env.TOKENMAXED_PROJECT;
  try {
    const statePath = join(dir, 'state.json');
    writeFileSync(statePath, JSON.stringify({ proj: false }), 'utf8');
    process.env.TOKENMAXED_STATE = statePath;
    process.env.TOKENMAXED_PROJECT = 'proj';
    const hooks = await TokenMaxed({ client: {}, directory: dir } as OpencodePluginInput);
    // The gated tool throws with the shared reason…
    await assert.rejects(
      hooks['tool.execute.before']!({ tool: OPENCODE_DELEGATE_TOOL, sessionID: 's', callID: 'c' }, { args: {} }),
      (e: Error) => e.message === PRETOOLUSE_DENY_REASON,
    );
    // …every other tool passes untouched.
    await hooks['tool.execute.before']!({ tool: 'read', sessionID: 's', callID: 'c' }, { args: {} });
  } finally {
    if (savedState === undefined) delete process.env.TOKENMAXED_STATE;
    else process.env.TOKENMAXED_STATE = savedState;
    if (savedProject === undefined) delete process.env.TOKENMAXED_PROJECT;
    else process.env.TOKENMAXED_PROJECT = savedProject;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the banner ---------------------------------------------------------------------

test('chat.message: injects the banner once per session; second message untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-oc-'));
  const saved = { ...process.env };
  try {
    // Point every read at the empty temp dir so the summary is small but real.
    process.env.TOKENMAXED_LANES = join(dir, 'lanes.yaml'); // absent ⇒ no lanes summary
    process.env.TOKENMAXED_LEDGER = join(dir, 'ledger.jsonl');
    process.env.TOKENMAXED_STATE = join(dir, 'state.json');
    const hooks = await TokenMaxed({ client: {}, directory: dir } as OpencodePluginInput);
    const first = { message: {}, parts: [] as { type: 'text'; text: string }[] };
    await hooks['chat.message']!({ sessionID: 'ses1' }, first);
    assert.equal(first.parts.length, 1);
    assert.equal(first.parts[0]!.type, 'text');
    assert.ok(first.parts[0]!.text.length > 0);
    const second = { message: {}, parts: [] as { type: 'text'; text: string }[] };
    await hooks['chat.message']!({ sessionID: 'ses1' }, second);
    assert.equal(second.parts.length, 0); // once per session
    const other = { message: {}, parts: [] as { type: 'text'; text: string }[] };
    await hooks['chat.message']!({ sessionID: 'ses2' }, other);
    assert.equal(other.parts.length, 1); // a new session gets its own banner
  } finally {
    process.env.TOKENMAXED_LANES = saved.TOKENMAXED_LANES;
    process.env.TOKENMAXED_LEDGER = saved.TOKENMAXED_LEDGER;
    process.env.TOKENMAXED_STATE = saved.TOKENMAXED_STATE;
    for (const k of ['TOKENMAXED_LANES', 'TOKENMAXED_LEDGER', 'TOKENMAXED_STATE']) {
      if (saved[k] === undefined) delete process.env[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chat.message: silent under the kill-switch', async () => {
  const saved = process.env.TOKENMAXED_DISABLE;
  try {
    process.env.TOKENMAXED_DISABLE = '1';
    const hooks = await TokenMaxed({ client: {}, directory: '/tmp' } as OpencodePluginInput);
    const out = { message: {}, parts: [] as { type: 'text'; text: string }[] };
    await hooks['chat.message']!({ sessionID: 'ses' }, out);
    assert.equal(out.parts.length, 0);
  } finally {
    if (saved === undefined) delete process.env.TOKENMAXED_DISABLE;
    else process.env.TOKENMAXED_DISABLE = saved;
  }
});

// --- the review loop (handler-level: injectable deps) ------------------------------

function idleDeps(over: Partial<IdleReviewDeps> & { action?: OpencodeReviewAction }): {
  deps: IdleReviewDeps;
  prompts: string[];
  toasts: string[];
} {
  const prompts: string[] = [];
  const toasts: string[] = [];
  const deps: IdleReviewDeps = {
    env: () => ({}) as NodeJS.ProcessEnv, // review loop is default-ON
    runReview: async () => over.action ?? { kind: 'allow' },
    promptBack: async (_s, text) => prompts.push(text),
    toast: async (m) => {
      toasts.push(m);
    },
    ...over,
  };
  return { deps, prompts, toasts };
}

test('idle handler: block ⇒ rework prompt-back with the marker prefix; nothing else', async () => {
  const { deps, prompts, toasts } = idleDeps({ action: { kind: 'block', reason: 'fix the null check' } });
  await makeIdleReviewHandler(deps)('ses');
  assert.deepEqual(prompts, [REWORK_PROMPT_PREFIX + 'fix the null check']);
  assert.deepEqual(toasts, []);
});

test('idle handler: allow ⇒ silent; notify ⇒ toast', async () => {
  const a = idleDeps({ action: { kind: 'allow' } });
  await makeIdleReviewHandler(a.deps)('ses');
  assert.deepEqual([a.prompts, a.toasts], [[], []]);
  const n = idleDeps({ action: { kind: 'notify', message: 'yielded after max rounds' } });
  await makeIdleReviewHandler(n.deps)('ses');
  assert.deepEqual(n.prompts, []);
  assert.deepEqual(n.toasts, ['yielded after max rounds']);
});

test('idle handler: a MISSING prompt API surfaces the notes as a toast (never fake success)', async () => {
  const { deps, toasts } = idleDeps({ action: { kind: 'block', reason: 'notes' } });
  delete (deps as { promptBack?: unknown }).promptBack;
  await makeIdleReviewHandler(deps)('ses');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0]!, /cannot re-prompt.*notes/s);
});

test('idle handler: prompt-back FAILURE falls back to a toast with the notes', async () => {
  const { deps, toasts } = idleDeps({
    action: { kind: 'block', reason: 'notes' },
    promptBack: async () => {
      throw new Error('http 500');
    },
  });
  await makeIdleReviewHandler(deps)('ses');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0]!, /prompt-back failed.*notes/s);
});

test('idle handler: a review that cannot RUN is surfaced, not silently skipped', async () => {
  const { deps, prompts, toasts } = idleDeps({
    runReview: async () => {
      throw new Error('review bundle not found');
    },
  });
  await makeIdleReviewHandler(deps)('ses');
  assert.deepEqual(prompts, []);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0]!, /could not run.*review bundle not found/s);
});

test('idle handler: concurrent idle for the SAME session runs one review; a second session is independent', async () => {
  let running = 0;
  let maxConcurrent = 0;
  let calls = 0;
  const { deps } = idleDeps({
    runReview: async () => {
      calls += 1;
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
      return { kind: 'allow' };
    },
  });
  const handle = makeIdleReviewHandler(deps);
  await Promise.all([handle('ses1'), handle('ses1'), handle('ses2')]);
  assert.equal(calls, 2); // ses1 deduped while in flight; ses2 independent
  assert.equal(maxConcurrent, 2);
  await handle('ses1'); // the guard RELEASES after completion (no permanent suppression)
  assert.equal(calls, 3);
});

test('idle handler: opted out ⇒ no review, no prompt-back, no toast', async () => {
  let reviewed = false;
  const { deps, prompts, toasts } = idleDeps({
    env: () => ({ TOKENMAXED_REVIEW_ON_STOP: 'false' }) as NodeJS.ProcessEnv,
    runReview: async () => {
      reviewed = true;
      return { kind: 'allow' };
    },
  });
  await makeIdleReviewHandler(deps)('ses');
  assert.deepEqual([reviewed, prompts, toasts], [false, [], []]);
});

// --- the review loop (plugin-level wiring) ------------------------------------------

test('session.idle: review loop is a no-op when opted out (no prompt-back, no toast)', async () => {
  const saved = process.env.TOKENMAXED_REVIEW_ON_STOP;
  const calls: string[] = [];
  try {
    process.env.TOKENMAXED_REVIEW_ON_STOP = 'false';
    const client = {
      session: { prompt: async () => calls.push('prompt') },
      tui: { showToast: async () => calls.push('toast') },
    };
    const hooks = await TokenMaxed({ client, directory: '/tmp' } as unknown as OpencodePluginInput);
    await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 'ses' } } });
    assert.deepEqual(calls, []);
  } finally {
    if (saved === undefined) delete process.env.TOKENMAXED_REVIEW_ON_STOP;
    else process.env.TOKENMAXED_REVIEW_ON_STOP = saved;
  }
});

test('session.idle: no sessionID or foreign event type ⇒ ignored', async () => {
  const hooks = await TokenMaxed({ client: {}, directory: '/tmp' } as OpencodePluginInput);
  await hooks.event!({ event: { type: 'message.updated', properties: {} } });
  await hooks.event!({ event: { type: 'session.idle', properties: {} } });
  // Reaching here without throwing is the assertion (fail-open contract).
});

test('REWORK_PROMPT_PREFIX marks prompt-backs so users can attribute the extra turn', () => {
  assert.match(REWORK_PROMPT_PREFIX, /TokenMaxed review/);
});
