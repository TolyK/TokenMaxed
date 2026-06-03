#!/usr/bin/env node
/**
 * TokenMaxed MCP server entry point. Thin: start the stdio server and let it run.
 * Logs go to stderr only (stdout is the MCP transport — never write to it).
 */

import { startStdioServer } from './server.ts';

startStdioServer().catch((err) => {
  process.stderr.write(`tokenmaxed-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
