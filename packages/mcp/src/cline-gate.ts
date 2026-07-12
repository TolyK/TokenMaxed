/**
 * F4 — the PURE part of the Cline PreToolUse gate, extracted from the hook
 * ENTRY (hook-cline-pretooluse.ts) so tests can import it without executing
 * the entry's top-level main() — which synchronously reads stdin (fd 0) and
 * would block a test runner forever.
 *
 * The two Cline surfaces name our delegate tool differently:
 *   - CLI/SDK: MCP tools are native `serverName__toolName` ⇒
 *     `tokenmaxed__router_delegate`, payload at `preToolUse.toolName`.
 *   - VS Code extension: the classic `use_mcp_tool` indirection with
 *     `parameters.server_name` + `parameters.tool_name`, payload fields
 *     snake_cased (`pre_tool_use.tool_name`).
 */

/** The delegate tool as the Cline CLI/SDK names it (server__tool). */
export const CLINE_DELEGATE_TOOL = 'tokenmaxed__router_delegate';

export interface ClinePreToolUsePayload {
  preToolUse?: { toolName?: unknown; parameters?: Record<string, unknown> };
  pre_tool_use?: { tool_name?: unknown; parameters?: Record<string, unknown> };
}

/** Pure: is this payload a call to OUR delegate tool (either surface's shape)? */
export function isDelegateCall(payload: ClinePreToolUsePayload): boolean {
  const cli = payload.preToolUse;
  const ext = payload.pre_tool_use;
  const toolName = typeof cli?.toolName === 'string' ? cli.toolName : typeof ext?.tool_name === 'string' ? ext.tool_name : '';
  if (toolName === CLINE_DELEGATE_TOOL) return true;
  if (toolName === 'use_mcp_tool') {
    const params = cli?.parameters ?? ext?.parameters ?? {};
    return params.server_name === 'tokenmaxed' && params.tool_name === 'router_delegate';
  }
  return false;
}
