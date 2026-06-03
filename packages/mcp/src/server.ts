/**
 * A-1 — stdio MCP server. THIN: it injects the core operations + config loaders,
 * builds the pure {@link createTools} list, advertises them, and routes CallTool
 * through {@link dispatch}. No routing/ledger logic lives here — all in core.
 *
 * This file (unlike tools.ts) DOES import `@tokenmaxed/core` by name at runtime;
 * that is fine because the server only ever runs after a build / as an installed
 * package where core's dist is present. Its logic is covered by the stdio smoke
 * test and the no-build tools.test.ts (which injects core via source).
 *
 * Config resolution (env overridable so the plugin can point at bundled paths):
 *   - lanes:  TOKENMAXED_LANES   (default config/lanes.yaml)
 *   - policy: TOKENMAXED_POLICY  (default config/policy.yaml)
 *   - ledger: TOKENMAXED_LEDGER  (default ~/.tokenmaxed/ledger.jsonl)
 *   - state:  TOKENMAXED_STATE   (toggle file; default ~/.tokenmaxed/state.json)
 *   - project key: TOKENMAXED_PROJECT (default "default")
 * Config is loaded lazily per call so the server starts even before setup, and
 * picks up edits without a restart. Loader errors become isError tool results.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { TASK_CATEGORIES, evaluate, filterEventsSince, routeDecide, summarize, tokenStats } from '@tokenmaxed/core';
import { JsonlLedger, loadLaneConfig, loadPolicyConfig } from '@tokenmaxed/core/node';

import { createTools, dispatch } from './tools.ts';
import { readEnabled, writeEnabled } from './toggle.ts';
import type { ToggleStore } from './toggle.ts';
import type { CorePort, ToolDef, ToolDeps } from './tools.ts';

const DEFAULT_LANES = 'config/lanes.yaml';
const DEFAULT_POLICY = 'config/policy.yaml';

/** A JSON-file-backed {@link ToggleStore}; tolerant of a missing/corrupt file. */
function fileToggleStore(statePath: string): ToggleStore {
  return {
    read: () => {
      if (!existsSync(statePath)) return {};
      try {
        return JSON.parse(readFileSync(statePath, 'utf8'));
      } catch {
        return {}; // corrupt file ⇒ treat as empty (default enabled)
      }
    },
    write: (state) => {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    },
  };
}

/** The real core operations, bound for injection into the tools. */
const CORE: CorePort = { filterEventsSince, summarize, tokenStats, routeDecide, evaluate, taskCategories: TASK_CATEGORIES };

/** Build the injected deps from the environment (lazy loaders per call). */
export function makeServerDeps(env: NodeJS.ProcessEnv = process.env): ToolDeps {
  const lanesPath = env.TOKENMAXED_LANES ?? DEFAULT_LANES;
  const policyPath = env.TOKENMAXED_POLICY ?? DEFAULT_POLICY;
  const ledgerPath = env.TOKENMAXED_LEDGER; // undefined ⇒ JsonlLedger default (~/.tokenmaxed)
  const statePath = env.TOKENMAXED_STATE ?? join(homedir(), '.tokenmaxed', 'state.json');
  const projectKey = env.TOKENMAXED_PROJECT ?? 'default';
  const store = fileToggleStore(statePath);
  return {
    readLedger: () => new JsonlLedger(ledgerPath).readAll(),
    // candidateLanes() is the documented route input (excludes capability-0
    // opt-outs); loaded lazily per call so config edits are picked up live.
    candidateLanes: (category) => loadLaneConfig(lanesPath).candidateLanes(category),
    loadPolicy: () => loadPolicyConfig(policyPath),
    getEnabled: () => readEnabled(store, projectKey),
    setEnabled: (enabled) => writeEnabled(store, projectKey, enabled),
    now: () => Date.now(),
  };
}

/** Advertised tool list for ListTools (name/description/inputSchema only). */
function advertisedTools(tools: readonly ToolDef[]) {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/** Create the MCP Server with handlers wired to {@link ToolDeps}. */
export function createServer(deps: ToolDeps): Server {
  const tools = createTools(CORE);
  const server = new Server(
    { name: 'tokenmaxed', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: advertisedTools(tools) }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const result = dispatch(tools, deps, request.params.name, request.params.arguments);
    // ToolResult is structurally a CallToolResult; the SDK's tools/call return is
    // a union (with experimental task results) so we narrow with a cast.
    return result as CallToolResult;
  });

  return server;
}

/** Start the server over stdio. Called by the bin entry. */
export async function startStdioServer(): Promise<void> {
  const server = createServer(makeServerDeps());
  await server.connect(new StdioServerTransport());
}
