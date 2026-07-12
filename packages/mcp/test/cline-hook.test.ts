/**
 * F4 — Cline hook behavior: both surfaces' PreToolUse payload shapes route to
 * the same gate, the deny reason speaks Cline's command dialect, and the
 * host-dialect rewrite helper is exact.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PRETOOLUSE_DENY_REASON } from '../src/hook.ts';
import { CLINE_DELEGATE_TOOL, isDelegateCall } from '../src/cline-gate.ts';
import { denyReasonForHost } from '../src/opencode-plugin.ts';

test('isDelegateCall: CLI shape (native server__tool name)', () => {
  assert.equal(isDelegateCall({ preToolUse: { toolName: CLINE_DELEGATE_TOOL, parameters: {} } }), true);
  assert.equal(isDelegateCall({ preToolUse: { toolName: 'read_files', parameters: {} } }), false);
  assert.equal(isDelegateCall({ preToolUse: { toolName: 'tokenmaxed__router_preview' } }), false); // only delegate is gated
});

test('isDelegateCall: extension shape (use_mcp_tool indirection, snake_case fields)', () => {
  assert.equal(
    isDelegateCall({ pre_tool_use: { tool_name: 'use_mcp_tool', parameters: { server_name: 'tokenmaxed', tool_name: 'router_delegate' } } }),
    true,
  );
  assert.equal(
    isDelegateCall({ pre_tool_use: { tool_name: 'use_mcp_tool', parameters: { server_name: 'other', tool_name: 'router_delegate' } } }),
    false,
  );
  assert.equal(
    isDelegateCall({ pre_tool_use: { tool_name: 'use_mcp_tool', parameters: { server_name: 'tokenmaxed', tool_name: 'router_preview' } } }),
    false,
  );
});

test('isDelegateCall: garbage/empty payloads are never a match (fail open)', () => {
  assert.equal(isDelegateCall({}), false);
  assert.equal(isDelegateCall({ preToolUse: { toolName: 42 as unknown as string } }), false);
});

test('denyReasonForHost: rewrites /tokenmaxed:x refs into each host dialect', () => {
  const dash = denyReasonForHost(PRETOOLUSE_DENY_REASON, '-');
  assert.doesNotMatch(dash, /\/tokenmaxed:[a-z]/);
  assert.match(dash, /\/tokenmaxed-on/);
  const underscore = denyReasonForHost(PRETOOLUSE_DENY_REASON, '_');
  assert.doesNotMatch(underscore, /\/tokenmaxed:[a-z]/);
  assert.match(underscore, /\/tokenmaxed_on/);
  // Multi-word command names convert their inner dashes in the underscore dialect.
  assert.equal(denyReasonForHost('run /tokenmaxed:prefer-lane now', '_'), 'run /tokenmaxed_prefer_lane now');
  assert.equal(denyReasonForHost('run /tokenmaxed:prefer-lane now', '-'), 'run /tokenmaxed-prefer-lane now');
});
