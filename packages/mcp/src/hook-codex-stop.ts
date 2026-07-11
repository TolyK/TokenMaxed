#!/usr/bin/env node
/**
 * REVIEW-LOOP — Stop gate entry for CODEX CLI (see hook-stop-main.ts). Codex's
 * Stop output schema is strict (additionalProperties: false; decision/reason/
 * continue/stopReason/suppressOutput/systemMessage only), so this dialect emits
 * {"decision":"block","reason"} without the Claude-only envelope. A block
 * auto-continues the turn with the reviewer notes — Codex's native primitive
 * for the rework loop.
 */

import { stopMain } from './hook-stop-main.ts';

stopMain('codex')
  .catch(() => {
    /* fail open — never wedge a session over a backstop hook */
  })
  .finally(() => process.exit(0));
