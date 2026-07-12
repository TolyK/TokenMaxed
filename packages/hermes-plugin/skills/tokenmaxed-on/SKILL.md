---
name: tokenmaxed-on
description: Turn TokenMaxed routing/offloading ON for this project (persisted). Re-enables delegating subtasks to cheaper capable lanes.
---

> **MANUAL-ONLY:** run this skill only when the user EXPLICITLY invokes it (e.g. `/<skill-name>`) or explicitly asks for exactly this action. Never auto-activate it from task matching.


# /tokenmaxed-on

Enable TokenMaxed routing for this project:

1. Call the MCP tool `mcp_tokenmaxed_router_set_enabled` with
   `{ "enabled": true }`.
2. Present its confirmation text to the user.
