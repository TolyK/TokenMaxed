---
name: tokenmaxed-status
description: Show whether TokenMaxed routing is enabled for this project, and check enabled API lanes for a stale pinned model (makes a provider /models call — key only, no repo/task content — and updates the local freshness cache; routing is never changed).
---

> **MANUAL-ONLY:** run this skill only when the user EXPLICITLY invokes it (e.g. `/<skill-name>`) or explicitly asks for exactly this action. Never auto-activate it from task matching.


# /tokenmaxed-status

1. Call the MCP tool `mcp_tokenmaxed_router_status` (no
   arguments).
2. Present its text result to the user verbatim — it shows the enabled/disabled
   state and any stale pinned models (with the newer version available).
