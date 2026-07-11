#!/usr/bin/env node
/**
 * REVIEW-LOOP — Stop gate entry for CLAUDE CODE (see hook-stop-main.ts for the
 * shared implementation and the full protection notes). Claude Code's Stop
 * contract accepts the hookSpecificOutput envelope alongside decision/reason.
 */

import { stopMain } from './hook-stop-main.ts';

// Force-exit AFTER main settles. Safe because the only stdout write is awaited to
// flush inside main before it resolves; the forced exit then also tears down any
// lingering handle (e.g. a stalled API-manager fetch the deadline race can't
// abort), so the Stop hook can never keep the turn from finishing.
stopMain('claude')
  .catch(() => {
    /* fail open — never wedge a session over a backstop hook */
  })
  .finally(() => process.exit(0));
