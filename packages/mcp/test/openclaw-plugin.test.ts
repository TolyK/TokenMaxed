/**
 * F3 — OpenClaw plugin behavior: host-identity env threading (no process.env
 * mutation), session-key extraction, the pure finalize revise/allow mapping,
 * and register-level wiring (once-per-session banner via before_prompt_build,
 * the before_tool_call veto shape, finalize opt-out).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PRETOOLUSE_DENY_REASON } from '../src/hook.ts';
import { denyReasonForHost, REWORK_PROMPT_PREFIX } from '../src/opencode-plugin.ts';
import {
  FINALIZE_HOOK_TIMEOUT_MS,
  OPENCLAW_DELEGATE_TOOL,
  finalizeDecisionFor,
  makeFinalizeHandler,
  openclawPluginEnv,
  sessionKeyFrom,
  tokenMaxedOpenclawPlugin,
} from '../src/openclaw-plugin.ts';
import type { FinalizeDeps, OpenclawPluginApi } from '../src/openclaw-plugin.ts';
import { REVIEW_CHILD_KILL_MS } from '../src/review-child.ts';

type Handler = (payload: Record<string, unknown>) => unknown;

function fakeApi(): { api: OpenclawPluginApi; handlers: Map<string, Handler>; opts: Map<string, { timeoutMs?: number }>; warnings: string[] } {
  const handlers = new Map<string, Handler>();
  const opts = new Map<string, { timeoutMs?: number }>();
  const warnings: string[] = [];
  const api: OpenclawPluginApi = {
    on: (name, handler, o) => {
      handlers.set(name, handler);
      if (o) opts.set(name, o);
    },
    logger: { warn: (m: string) => void warnings.push(m) },
  };
  return { api, handlers, opts, warnings };
}

test('openclawPluginEnv: defaults host=openclaw; explicit env wins; process env untouched', () => {
  const processEnv = { HOME: '/home/u' } as NodeJS.ProcessEnv;
  const env = openclawPluginEnv(processEnv);
  assert.equal(env.TOKENMAXED_HOST, 'openclaw');
  assert.equal(processEnv.TOKENMAXED_HOST, undefined);
  assert.equal(openclawPluginEnv({ TOKENMAXED_HOST: 'my-fork' } as NodeJS.ProcessEnv).TOKENMAXED_HOST, 'my-fork');
});

test('sessionKeyFrom: reads the common payload shapes; undefined when absent', () => {
  assert.equal(sessionKeyFrom({ sessionKey: 'a' }), 'a');
  assert.equal(sessionKeyFrom({ sessionId: 'b' }), 'b');
  assert.equal(sessionKeyFrom({ sessionID: 'c' }), 'c');
  assert.equal(sessionKeyFrom({ session: { key: 'd' } }), 'd');
  assert.equal(sessionKeyFrom({ session: { id: 'e' } }), 'e');
  assert.equal(sessionKeyFrom({ other: 1 }), undefined);
});

test('finalizeDecisionFor: block ⇒ revise with the marker-prefixed notes + the shared round cap', () => {
  const d = finalizeDecisionFor({ kind: 'block', reason: 'fix the null check' }, 2);
  assert.ok(d);
  assert.equal(d!.action, 'revise');
  assert.equal(d!.retry.instruction, REWORK_PROMPT_PREFIX + 'fix the null check');
  assert.equal(d!.retry.maxAttempts, 2);
  // The stable idempotencyKey is what bounds the loop HOST-SIDE (one retry chain).
  assert.equal(d!.retry.idempotencyKey, 'tokenmaxed-review');
  // allow AND notify let the natural answer stand (notify surfaces via logger).
  assert.equal(finalizeDecisionFor({ kind: 'allow' }, 2), undefined);
  assert.equal(finalizeDecisionFor({ kind: 'notify', message: 'yielded' }, 2), undefined);
});

test('register: the three hooks are wired', () => {
  const { api, handlers } = fakeApi();
  tokenMaxedOpenclawPlugin.register(api);
  assert.deepEqual([...handlers.keys()].sort(), ['before_agent_finalize', 'before_prompt_build', 'before_tool_call']);
});

test('before_prompt_build: banner once per session key; other sessions independent; kill-switch silent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-ocl-'));
  const saved = { ...process.env };
  try {
    process.env.TOKENMAXED_LANES = join(dir, 'lanes.yaml'); // absent ⇒ tiny real summary
    process.env.TOKENMAXED_LEDGER = join(dir, 'ledger.jsonl');
    process.env.TOKENMAXED_STATE = join(dir, 'state.json');
    delete process.env.TOKENMAXED_DISABLE;
    const { api, handlers } = fakeApi();
    tokenMaxedOpenclawPlugin.register(api);
    const h = handlers.get('before_prompt_build')!;
    const first = (await h({ sessionKey: 's1' })) as { prependContext?: string } | undefined;
    assert.ok(first?.prependContext && first.prependContext.length > 0);
    assert.equal(await h({ sessionKey: 's1' }), undefined); // once per session
    const other = (await h({ sessionKey: 's2' })) as { prependContext?: string } | undefined;
    assert.ok(other?.prependContext);

    // Kill-switch ⇒ silent (fresh plugin instance so the guard is empty).
    process.env.TOKENMAXED_DISABLE = '1';
    const killed = fakeApi();
    tokenMaxedOpenclawPlugin.register(killed.api);
    assert.equal(await killed.handlers.get('before_prompt_build')!({ sessionKey: 's3' }), undefined);
  } finally {
    for (const k of ['TOKENMAXED_LANES', 'TOKENMAXED_LEDGER', 'TOKENMAXED_STATE', 'TOKENMAXED_DISABLE']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('before_tool_call: vetoes router_delegate with the shared reason when routing is off; other tools untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-ocl-'));
  const saved = { state: process.env.TOKENMAXED_STATE, project: process.env.TOKENMAXED_PROJECT };
  try {
    const statePath = join(dir, 'state.json');
    writeFileSync(statePath, JSON.stringify({ proj: false }), 'utf8');
    process.env.TOKENMAXED_STATE = statePath;
    process.env.TOKENMAXED_PROJECT = 'proj';
    const { api, handlers } = fakeApi();
    tokenMaxedOpenclawPlugin.register(api);
    const h = handlers.get('before_tool_call')!;
    const decision = (await h({ toolName: OPENCLAW_DELEGATE_TOOL })) as { block?: boolean; blockReason?: string };
    assert.equal(decision.block, true);
    // The reason speaks OpenClaw's command dialect (/tokenmaxed_x, [a-z0-9_]).
    assert.equal(decision.blockReason, denyReasonForHost(PRETOOLUSE_DENY_REASON, '_'));
    assert.equal(await h({ toolName: 'exec' }), undefined);
    // Routing back on ⇒ allow (undefined).
    writeFileSync(statePath, JSON.stringify({ proj: true }), 'utf8');
    assert.equal(await h({ toolName: OPENCLAW_DELEGATE_TOOL }), undefined);
  } finally {
    if (saved.state === undefined) delete process.env.TOKENMAXED_STATE;
    else process.env.TOKENMAXED_STATE = saved.state;
    if (saved.project === undefined) delete process.env.TOKENMAXED_PROJECT;
    else process.env.TOKENMAXED_PROJECT = saved.project;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('before_agent_finalize: opted out ⇒ undefined (no child spawn, no revise)', async () => {
  const saved = process.env.TOKENMAXED_REVIEW_ON_STOP;
  try {
    process.env.TOKENMAXED_REVIEW_ON_STOP = 'false';
    const { api, handlers, warnings } = fakeApi();
    tokenMaxedOpenclawPlugin.register(api);
    assert.equal(await handlers.get('before_agent_finalize')!({ sessionKey: 's' }), undefined);
    assert.deepEqual(warnings, []);
  } finally {
    if (saved === undefined) delete process.env.TOKENMAXED_REVIEW_ON_STOP;
    else process.env.TOKENMAXED_REVIEW_ON_STOP = saved;
  }
});

// --- the finalize handler (injectable deps) -------------------------------------

function memCounter(): { store: NonNullable<FinalizeDeps['counter']>; values: Map<string, number>; failWrites: boolean } {
  const values = new Map<string, number>();
  const box = {
    values,
    failWrites: false,
    store: {
      read: (id: string) => values.get(id) ?? 0,
      write: (id: string, n: number) => {
        if (box.failWrites) return false;
        values.set(id, n);
        return true;
      },
    },
  };
  return box;
}

function finalizeDeps(over: Partial<FinalizeDeps> = {}): { deps: FinalizeDeps; surfaced: string[]; reviewedIds: string[]; reviewedEnvs: NodeJS.ProcessEnv[] } {
  const surfaced: string[] = [];
  const reviewedIds: string[] = [];
  const reviewedEnvs: NodeJS.ProcessEnv[] = [];
  const deps: FinalizeDeps = {
    env: () => ({}) as NodeJS.ProcessEnv, // review loop default-ON
    runReview: async (id, env) => {
      reviewedIds.push(id);
      reviewedEnvs.push(env);
      return { kind: 'allow' };
    },
    surface: async (m) => {
      surfaced.push(m);
    },
    counter: memCounter().store,
    ...over,
  };
  return { deps, surfaced, reviewedIds, reviewedEnvs };
}

test('finalize handler: block ⇒ revise decision; allow ⇒ undefined; notify ⇒ surfaced + natural answer', async () => {
  const b = finalizeDeps({ runReview: async () => ({ kind: 'block', reason: 'notes' }) });
  const decision = (await makeFinalizeHandler(b.deps)({ sessionKey: 's' })) as { action: string; retry: { instruction: string } };
  assert.equal(decision.action, 'revise');
  assert.equal(decision.retry.instruction, REWORK_PROMPT_PREFIX + 'notes');

  const a = finalizeDeps();
  assert.equal(await makeFinalizeHandler(a.deps)({ sessionKey: 's' }), undefined);
  assert.deepEqual(a.surfaced, []);

  const n = finalizeDeps({ runReview: async () => ({ kind: 'notify', message: 'yielded after max rounds' }) });
  assert.equal(await makeFinalizeHandler(n.deps)({ sessionKey: 's' }), undefined);
  assert.deepEqual(n.surfaced, ['yielded after max rounds']);
});

test('finalize handler: a review that cannot RUN is surfaced, never silent', async () => {
  const { deps, surfaced } = finalizeDeps({
    runReview: async () => {
      throw new Error('review bundle not found');
    },
  });
  assert.equal(await makeFinalizeHandler(deps)({ sessionKey: 's' }), undefined);
  assert.equal(surfaced.length, 1);
  assert.match(surfaced[0]!, /could not run.*review bundle not found/s);
});

test('finalize handler: keyless payloads share ONE stable per-instance key; instances differ', async () => {
  const a = finalizeDeps();
  const handleA = makeFinalizeHandler(a.deps);
  await handleA({});
  await handleA({});
  assert.equal(a.reviewedIds.length, 2);
  assert.equal(a.reviewedIds[0], a.reviewedIds[1]); // stable ⇒ OUR counter bounds keyless loops
  assert.match(a.reviewedIds[0]!, /^keyless-/);
  const b = finalizeDeps();
  await makeFinalizeHandler(b.deps)({});
  assert.notEqual(b.reviewedIds[0], a.reviewedIds[0]); // never a cross-instance shared key
});

test('finalize handler: the PARENT owns the counter — banks on revise, resets on allow/notify, prior rides via env', async () => {
  const box = memCounter();
  let kind: 'block' | 'allow' | 'notify' = 'block';
  const reviewedEnvs: NodeJS.ProcessEnv[] = [];
  const { deps } = finalizeDeps({
    counter: box.store,
    runReview: async (_id, env) => {
      reviewedEnvs.push(env);
      return kind === 'notify' ? { kind, message: 'yielded' } : kind === 'block' ? { kind, reason: 'notes' } : { kind };
    },
  });
  const handle = makeFinalizeHandler(deps);
  assert.ok(await handle({ sessionKey: 's' })); // block ⇒ revise returned
  assert.equal(box.values.get('s'), 1); // round banked by the PARENT
  assert.equal(reviewedEnvs.at(-1)!.TOKENMAXED_REVIEW_PRIOR_BLOCKS, '0'); // prior rode into the child
  assert.ok(await handle({ sessionKey: 's' }));
  assert.equal(box.values.get('s'), 2);
  assert.equal(reviewedEnvs.at(-1)!.TOKENMAXED_REVIEW_PRIOR_BLOCKS, '1');
  kind = 'allow';
  await handle({ sessionKey: 's' });
  assert.equal(box.values.get('s'), 0); // reset on allow
  kind = 'notify';
  await handle({ sessionKey: 's' });
  assert.equal(box.values.get('s'), 0); // reset on notify
});

test('finalize handler: KEYLESS payloads accumulate on the shared per-instance counter (bounded by US, not host retry semantics)', async () => {
  const box = memCounter();
  const reviewedEnvs: NodeJS.ProcessEnv[] = [];
  const { deps } = finalizeDeps({
    counter: box.store,
    runReview: async (_id, env) => {
      reviewedEnvs.push(env);
      return { kind: 'block', reason: 'notes' };
    },
  });
  const handle = makeFinalizeHandler(deps);
  assert.ok(await handle({})); // keyless block #1
  assert.ok(await handle({})); // keyless block #2 - SAME counter key
  const key = [...box.values.keys()][0]!;
  assert.match(key, /^keyless-/);
  assert.equal(box.values.get(key), 2); // accumulated, not reset per call
  assert.equal(reviewedEnvs[0]!.TOKENMAXED_REVIEW_PRIOR_BLOCKS, '0');
  assert.equal(reviewedEnvs[1]!.TOKENMAXED_REVIEW_PRIOR_BLOCKS, '1'); // prior threads through
});

test('finalize handler: concurrent KEYLESS finalizes dedup on the shared key; guard releases after', async () => {
  let calls = 0;
  const { deps } = finalizeDeps({
    runReview: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { kind: 'allow' };
    },
  });
  const handle = makeFinalizeHandler(deps);
  await Promise.all([handle({}), handle({})]);
  assert.equal(calls, 1); // both keyless - one shared in-flight key
  await handle({});
  assert.equal(calls, 2); // released after completion
});

test('finalize handler: a counter write failure means NO revise (never-stuck), surfaced', async () => {
  const box = memCounter();
  box.failWrites = true;
  const { deps, surfaced } = finalizeDeps({
    counter: box.store,
    runReview: async () => ({ kind: 'block', reason: 'notes' }),
  });
  assert.equal(await makeFinalizeHandler(deps)({ sessionKey: 's' }), undefined);
  assert.equal(surfaced.length, 1);
  assert.match(surfaced[0]!, /loop-state file could not be written.*notes/s);
});

test('finalize handler: concurrent finalize for the SAME session runs one review; guard releases after', async () => {
  let calls = 0;
  const { deps } = finalizeDeps({
    runReview: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { kind: 'allow' };
    },
  });
  const handle = makeFinalizeHandler(deps);
  await Promise.all([handle({ sessionKey: 's1' }), handle({ sessionKey: 's1' }), handle({ sessionKey: 's2' })]);
  assert.equal(calls, 2);
  await handle({ sessionKey: 's1' });
  assert.equal(calls, 3); // released, not permanently suppressed
});

test('register: finalize registers with a self-requested timeout covering the child budget', () => {
  const { api, opts } = fakeApi();
  tokenMaxedOpenclawPlugin.register(api);
  const t = opts.get('before_agent_finalize')?.timeoutMs;
  assert.equal(t, FINALIZE_HOOK_TIMEOUT_MS);
  assert.ok(FINALIZE_HOOK_TIMEOUT_MS >= REVIEW_CHILD_KILL_MS + 5_000, 'hook budget must cover the child kill budget');
});
