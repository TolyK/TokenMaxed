/**
 * F6 — pi extension behavior: native tool registration over the shared deps,
 * the tool_call veto in pi's /skill: dialect, once-per-session banner with
 * session_start reset, env threading (no process.env mutation), and the
 * statusline push.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PRETOOLUSE_DENY_REASON } from '../src/hook.ts';
import tokenMaxedPiExtension, { PI_DELEGATE_TOOL, denyReasonForPi, piExtensionEnv, spawnToolChild } from '../src/pi-extension.ts';
import { REWORK_PROMPT_PREFIX } from '../src/opencode-plugin.ts';
import type { PiExtensionApi } from '../src/pi-extension.ts';

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function fakePi(): {
  pi: PiExtensionApi;
  tools: Map<string, Record<string, unknown>>;
  handlers: Map<string, Handler>;
  sent: string[];
} {
  const tools = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, Handler>();
  const sent: string[] = [];
  const pi: PiExtensionApi = {
    on: (event, handler) => {
      handlers.set(event, handler as Handler);
    },
    registerTool: (def) => {
      tools.set(def.name as string, def);
    },
    sendUserMessage: (content) => {
      sent.push(content);
    },
  };
  return { pi, tools, handlers, sent };
}

function tempEnv(): { dir: string; saved: Record<string, string | undefined>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmaxed-pi-'));
  const keys = ['TOKENMAXED_LANES', 'TOKENMAXED_LEDGER', 'TOKENMAXED_STATE', 'TOKENMAXED_DISABLE', 'TOKENMAXED_PROJECT', 'TOKENMAXED_REVIEW_ON_STOP'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.TOKENMAXED_LANES = join(dir, 'lanes.yaml');
  process.env.TOKENMAXED_LEDGER = join(dir, 'ledger.jsonl');
  process.env.TOKENMAXED_STATE = join(dir, 'state.json');
  delete process.env.TOKENMAXED_DISABLE;
  // Env beats the developer's real ~/.tokenmaxed settings (effectiveEnv fills
  // only UNSET vars) — the review tests must not depend on the machine.
  process.env.TOKENMAXED_REVIEW_ON_STOP = 'true';
  return {
    dir,
    saved,
    cleanup: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('denyReasonForPi: /tokenmaxed:x refs become pi /skill:tokenmaxed-x commands', () => {
  const out = denyReasonForPi(PRETOOLUSE_DENY_REASON);
  assert.doesNotMatch(out, /\/tokenmaxed:[a-z]/);
  assert.match(out, /\/skill:tokenmaxed-on/);
});

test('piExtensionEnv: defaults host=pi + project dirs + prices pin; explicit env wins; no mutation', () => {
  const processEnv = { HOME: '/home/u' } as NodeJS.ProcessEnv;
  const env = piExtensionEnv(processEnv, 'file:///opt/tm/extension/index.ts');
  assert.equal(env.TOKENMAXED_HOST, 'pi');
  assert.equal(env.TOKENMAXED_PROJECT_DIR, process.cwd());
  assert.equal(env.TOKENMAXED_PRICES, '/opt/tm/prices.seed.json'); // one level above extension/
  assert.equal(processEnv.TOKENMAXED_HOST, undefined); // never mutated
  const explicit = piExtensionEnv({ TOKENMAXED_HOST: 'my-fork', TOKENMAXED_PRICES: '/p.json' } as NodeJS.ProcessEnv, 'file:///opt/tm/extension/index.ts');
  assert.equal(explicit.TOKENMAXED_HOST, 'my-fork');
  assert.equal(explicit.TOKENMAXED_PRICES, '/p.json');
});

test('factory: registers every router tool with the tokenmaxed_ prefix + the lifecycle events', () => {
  const t = tempEnv();
  try {
    const { pi, tools, handlers } = fakePi();
    tokenMaxedPiExtension(pi);
    assert.ok(tools.size >= 8, `expected the full router tool set, got ${tools.size}`);
    assert.ok(tools.has(PI_DELEGATE_TOOL));
    for (const name of tools.keys()) assert.match(name, /^tokenmaxed_/, `${name}: provenance prefix`);
    for (const ev of ['session_start', 'before_agent_start', 'tool_call', 'agent_settled', 'turn_end']) {
      assert.ok(handlers.has(ev), `${ev} handler registered`);
    }
  } finally {
    t.cleanup();
  }
});

test('tool_call: vetoes the delegate with the /skill: dialect when routing is off; others untouched', async () => {
  const t = tempEnv();
  try {
    writeFileSync(join(t.dir, 'state.json'), JSON.stringify({ proj: false }), 'utf8');
    process.env.TOKENMAXED_PROJECT = 'proj';
    const { pi, handlers } = fakePi();
    tokenMaxedPiExtension(pi);
    const h = handlers.get('tool_call')!;
    const decision = (await h({ toolName: PI_DELEGATE_TOOL }, {})) as { block?: boolean; reason?: string };
    assert.equal(decision.block, true);
    assert.match(decision.reason!, /\/skill:tokenmaxed-on/);
    assert.equal(await h({ toolName: 'bash' }, {}), undefined);
    // Routing back on ⇒ allow.
    writeFileSync(join(t.dir, 'state.json'), JSON.stringify({ proj: true }), 'utf8');
    assert.equal(await h({ toolName: PI_DELEGATE_TOOL }, {}), undefined);
  } finally {
    t.cleanup();
  }
});

test('before_agent_start: banner once per session; session_start resets; kill-switch silent', async () => {
  const t = tempEnv();
  try {
    const { pi, handlers } = fakePi();
    tokenMaxedPiExtension(pi);
    const start = handlers.get('session_start')!;
    const before = handlers.get('before_agent_start')!;
    await start({}, {});
    const first = (await before({}, {})) as { message?: { content: string; customType: string } } | undefined;
    assert.ok(first?.message?.content && first.message.content.length > 0);
    assert.equal(first!.message!.customType, 'tokenmaxed-banner');
    assert.equal(await before({}, {}), undefined); // once per session
    await start({}, {}); // new session ⇒ banner again
    assert.ok((await before({}, {})) !== undefined);

    process.env.TOKENMAXED_DISABLE = '1';
    await start({}, {});
    assert.equal(await before({}, {}), undefined); // silent under the kill-switch
  } finally {
    t.cleanup();
  }
});

test('statusline: session_start pushes the tmax gauge via ctx.ui.setStatus; kill-switch clears it', async () => {
  const t = tempEnv();
  try {
    const { pi, handlers } = fakePi();
    tokenMaxedPiExtension(pi);
    const statuses: Array<string | undefined> = [];
    const ctx = { hasUI: true, ui: { setStatus: (_k: string, text: string | undefined) => void statuses.push(text) } };
    await handlers.get('session_start')!({}, ctx);
    assert.equal(statuses.length, 1);
    assert.match(statuses[0]!, /^tmax · /);
    process.env.TOKENMAXED_DISABLE = '1';
    await handlers.get('turn_end')!({}, ctx);
    assert.equal(statuses.at(-1), undefined); // cleared, not stale
  } finally {
    t.cleanup();
  }
});

test('registered tool execute: routes through runTool (the child seam) with host env; errors throw', async () => {
  const t = tempEnv();
  try {
    const { pi, tools } = fakePi();
    const calls: Array<{ name: string; env: NodeJS.ProcessEnv }> = [];
    tokenMaxedPiExtension(pi, {
      runTool: async (name, _args, env) => {
        calls.push({ name, env });
        return name === 'router_savings'
          ? { content: [{ type: 'text', text: 'ok' }], structuredContent: { x: 1 } }
          : { content: [{ type: 'text', text: 'boom' }], isError: true };
      },
    });
    const savings = tools.get('tokenmaxed_router_savings')!;
    type Exec = (id: string, p: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
    const result = await (savings.execute as Exec)('call-1', {});
    assert.equal(result.content[0]!.text, 'ok');
    assert.deepEqual(result.details, { x: 1 });
    assert.equal(calls[0]!.name, 'router_savings'); // UNPREFIXED name into the shared dispatch
    assert.equal(calls[0]!.env.TOKENMAXED_HOST, 'pi'); // host identity threads into the child
    // isError results become thrown errors (pi's error contract).
    const status = tools.get('tokenmaxed_router_status')!;
    await assert.rejects((status.execute as Exec)('call-2', {}), /boom/);
  } finally {
    t.cleanup();
  }
});

// --- the review path at EXTENSION level (injected review; real wiring) -----------

function memCounter() {
  const values = new Map<string, number>();
  return {
    values,
    store: {
      read: (id: string) => values.get(id) ?? 0,
      write: (id: string, n: number) => {
        values.set(id, n);
        return true;
      },
    },
  };
}

test('agent_settled: block ⇒ followUp rework with the marker prefix; counter banked per session key', async () => {
  const t = tempEnv();
  try {
    const { pi, handlers, sent } = fakePi();
    const box = memCounter();
    tokenMaxedPiExtension(pi, {
      runReview: async () => ({ kind: 'block', reason: 'fix the null check' }),
      counter: box.store,
    });
    const ctx = {};
    await handlers.get('session_start')!({}, ctx);
    await handlers.get('agent_settled')!({}, ctx);
    assert.equal(sent.length, 1);
    assert.equal(sent[0], REWORK_PROMPT_PREFIX + 'fix the null check');
    assert.equal([...box.values.values()][0], 1); // round banked under the session key
  } finally {
    t.cleanup();
  }
});

test('agent_settled: a review finishing AFTER a session switch never prompts the new session (surfaced instead)', async () => {
  const t = tempEnv();
  try {
    const { pi, handlers, sent } = fakePi();
    const notes: string[] = [];
    let releaseReview: (() => void) | undefined;
    tokenMaxedPiExtension(pi, {
      runReview: () =>
        new Promise((resolve) => {
          releaseReview = () => resolve({ kind: 'block', reason: 'stale notes' });
        }),
      counter: memCounter().store,
    });
    const ctx = { hasUI: true, ui: { notify: (m: string) => void notes.push(m), setStatus: () => {} } };
    await handlers.get('session_start')!({}, ctx);
    const settled = handlers.get('agent_settled')!({}, ctx) as Promise<void>;
    await new Promise((r) => setTimeout(r, 10)); // review in flight…
    await handlers.get('session_start')!({}, ctx); // …session switches
    releaseReview!();
    await settled;
    assert.deepEqual(sent, []); // never delivered into the newer session
    assert.equal(notes.length, 1); // surfaced via toast fallback
    assert.match(notes[0]!, /prompt-back failed.*stale notes/s);
  } finally {
    t.cleanup();
  }
});

test('spawnToolChild: a PRE-aborted signal rejects immediately (no TDZ, no spawn leak)', async () => {
  const script = new URL('../../pi-extension/extension/tokenmaxed-tool.mjs', import.meta.url).pathname;
  const controller = new AbortController();
  controller.abort(); // aborted BEFORE the call
  await assert.rejects(spawnToolChild(script, 'router_savings', {}, { ...process.env } as NodeJS.ProcessEnv, controller.signal), /cancelled/);
});

test('spawnToolChild: an aborted signal kills the child and rejects as cancelled', async () => {
  // Use the committed pi tool child as a real long-enough process (node startup
  // gives the abort a window; the tool name is irrelevant to cancellation).
  const script = new URL('../../pi-extension/extension/tokenmaxed-tool.mjs', import.meta.url).pathname;
  const controller = new AbortController();
  const p = spawnToolChild(script, 'router_savings', {}, { ...process.env } as NodeJS.ProcessEnv, controller.signal);
  controller.abort();
  await assert.rejects(p, /cancelled/);
});

test('registered execute forwards pi\'s AbortSignal into the runTool seam', async () => {
  const t = tempEnv();
  try {
    const { pi, tools } = fakePi();
    let seen: AbortSignal | undefined;
    tokenMaxedPiExtension(pi, {
      runTool: async (_n, _a, _e, signal) => {
        seen = signal;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    const controller = new AbortController();
    type Exec = (id: string, p: Record<string, unknown>, s?: AbortSignal) => Promise<unknown>;
    await (tools.get('tokenmaxed_router_savings')!.execute as Exec)('c', {}, controller.signal);
    assert.equal(seen, controller.signal);
  } finally {
    t.cleanup();
  }
});
