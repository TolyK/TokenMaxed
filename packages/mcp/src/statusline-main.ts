#!/usr/bin/env node
/**
 * A3 — statusline entrypoint (bundled to packages/plugin/statusline.mjs).
 * Thin: all logic lives in statusline.ts so tests import it without running
 * main. Exit 0 always (a status bar must never surface an error).
 */

import { statuslineMain } from './statusline.ts';

statuslineMain()
  .catch(() => {
    /* fail open — never let the gauge disrupt the host status bar */
  })
  .finally(() => process.exit(0));
