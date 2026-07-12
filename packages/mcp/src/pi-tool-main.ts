/**
 * F6 — the pi TOOL child process. The pi extension runs IN-PROCESS in pi's TUI
 * (jiti), and the router's trusted CLI executor is deliberately spawnSync-based
 * — executing router_delegate in-process would freeze the terminal for the
 * whole lane run (minutes). So the extension spawns THIS entry (bundled next
 * to it as tokenmaxed-tool.mjs) per tool call and reads ONE JSON result.
 *
 * argv[2] = the ROUTER tool name (router_delegate, router_preview, ...);
 * stdin  = the tool arguments as JSON.
 * stdout = exactly one JSON line: the ToolResult from the shared dispatch
 *          ({ content, structuredContent?, isError? }).
 * Exit 0 always; unexpected crashes print an isError result (never silence).
 */

import { readFileSync } from 'node:fs';

import { CORE, makeServerDeps } from './server.ts';
import { effectiveEnv } from './settings.ts';
import { createTools, dispatch } from './tools.ts';

async function main(): Promise<void> {
  const name = process.argv[2] ?? '';
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    /* empty/invalid stdin ⇒ {} — dispatch validates */
  }
  const TOOLS = createTools(CORE);
  const deps = makeServerDeps(effectiveEnv(process.env));
  const result = await dispatch(TOOLS, deps, name, args);
  await print(JSON.stringify(result));
}

function print(s: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(s + '\n', () => resolve());
  });
}

void (async () => {
  try {
    await main();
  } catch (e) {
    await print(
      JSON.stringify({
        content: [{ type: 'text', text: `TokenMaxed tool failed: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      }),
    );
  }
})();
