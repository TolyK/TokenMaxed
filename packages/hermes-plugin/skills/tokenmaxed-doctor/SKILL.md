---
name: tokenmaxed-doctor
description: Run the TokenMaxed doctor diagnostic command to check config, lanes, availability, gates, and freshness. Reports a prioritized list of actionable problems with fixes.
---

> **MANUAL-ONLY:** run this skill only when the user EXPLICITLY invokes it (e.g. `/<skill-name>`) or explicitly asks for exactly this action. Never auto-activate it from task matching.


# /tokenmaxed-doctor

1. Call the MCP tool `mcp_tokenmaxed_router_doctor` (no arguments).
2. Present the status report / findings to the user verbatim.
