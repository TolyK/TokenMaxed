/**
 * A-2 tests — guard the plugin manifest against drift. Pure file reads, no build:
 * asserts the .claude-plugin/plugin.json shape Claude Code requires and that the
 * bundled MCP server is referenced via ${CLAUDE_PLUGIN_ROOT} (so it resolves at
 * the install location, per the A-0 spike). `claude plugin validate` covers the
 * full schema; this locks the fields this project depends on.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const manifest = JSON.parse(
  readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
) as {
  name: string;
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  hooks?: {
    PreToolUse?: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
    Stop?: Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>;
  };
};

test('manifest declares the tokenmaxed plugin with required identity', () => {
  assert.equal(manifest.name, 'tokenmaxed');
});

test('manifest registers a single bundled stdio MCP server', () => {
  const ids = Object.keys(manifest.mcpServers);
  assert.deepEqual(ids, ['tokenmaxed']);
  const server = manifest.mcpServers.tokenmaxed!;
  assert.equal(server.command, 'node');
  // Must point at the bundled single-file server via the install-root variable,
  // never a workspace-relative path (which would not exist once installed).
  assert.ok(
    server.args.some((a) => a.includes('${CLAUDE_PLUGIN_ROOT}') && a.endsWith('server/index.mjs')),
    `args should reference \${CLAUDE_PLUGIN_ROOT}/server/index.mjs, got ${JSON.stringify(server.args)}`,
  );
});

test('manifest never points lane/policy config at the repo dir (RCE-safe)', () => {
  // SECURITY: lanes/policy decide what executes + where data goes, so they must
  // default to the user-owned ~/.tokenmaxed — never the repo. The manifest must
  // NOT override them to a project path (which a cloned repo could control).
  const env = manifest.mcpServers.tokenmaxed!.env ?? {};
  assert.equal(env.TOKENMAXED_LANES, undefined, 'lanes must not be repo-controlled');
  assert.equal(env.TOKENMAXED_POLICY, undefined, 'policy must not be repo-controlled');
  for (const [k, v] of Object.entries(env)) {
    if (v.includes('${CLAUDE_PROJECT_DIR}')) {
      assert.equal(k, 'TOKENMAXED_PROJECT', `only the toggle key may use the project dir, not ${k}`);
    }
  }
});

test('manifest sources prices from the plugin root and state from plugin data', () => {
  const env = manifest.mcpServers.tokenmaxed!.env ?? {};
  assert.match(env.TOKENMAXED_PRICES ?? '', /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.match(env.TOKENMAXED_STATE ?? '', /\$\{CLAUDE_PLUGIN_DATA\}/);
});

test('manifest registers a PreToolUse backstop on router_delegate', () => {
  const pre = manifest.hooks?.PreToolUse ?? [];
  const entry = pre.find((e) => /router_delegate/.test(e.matcher));
  assert.ok(entry, 'a PreToolUse matcher for router_delegate must exist');
  // Must match the full plugin tool-name format Claude Code exposes (A-2).
  assert.equal(entry!.matcher, 'mcp__plugin_tokenmaxed_tokenmaxed__router_delegate');
  const cmd = entry!.hooks[0]!.command;
  assert.match(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/pretooluse\.mjs/);
  // SECURITY: the user-controlled project dir must NOT be spliced into the shell
  // command (it could contain $(...)/backticks); the hook reads it from env.
  assert.doesNotMatch(cmd, /\$\{CLAUDE_PROJECT_DIR\}/);
});

test('the committed bundled hooks exist', () => {
  const pre = readFileSync(new URL('../hooks/pretooluse.mjs', import.meta.url), 'utf8');
  assert.ok(pre.length > 500, 'PreToolUse hook bundle should be a non-trivial file');
  assert.match(pre, /TokenMaxed PreToolUse hook/);
  const stop = readFileSync(new URL('../hooks/stop.mjs', import.meta.url), 'utf8');
  assert.ok(stop.length > 500, 'Stop hook bundle should be a non-trivial file');
  assert.match(stop, /TokenMaxed Stop gate/);
});

test('manifest registers a Stop hook (no matcher) pointing at the bundled gate', () => {
  const stop = manifest.hooks?.Stop ?? [];
  assert.equal(stop.length, 1, 'exactly one Stop hook group');
  assert.equal(stop[0]!.matcher, undefined, 'Stop is not tool-scoped — no matcher');
  assert.match(stop[0]!.hooks[0]!.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/stop\.mjs/);
});

test('the committed bundled server exists (the install artifact a fresh clone ships)', () => {
  // server/index.mjs is committed, not gitignored, so installs from a git tag /
  // marketplace have the file plugin.json launches. Guards accidental removal.
  const bundle = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.ok(bundle.length > 1000, 'bundle should be a non-trivial single file');
  assert.match(bundle, /Bundled TokenMaxed MCP server/);
});
