---
name: tokenmaxed-off
description: Turn TokenMaxed routing/offloading OFF for this project (persisted). the agent stops delegating subtasks to other lanes for the rest of the session.
---

> **MANUAL-ONLY:** run this skill only when the user EXPLICITLY invokes it (e.g. `/<skill-name>`) or explicitly asks for exactly this action. Never auto-activate it from task matching.


# /tokenmaxed-off

Disable TokenMaxed routing for this project:

1. Call the MCP tool `tokenmaxed__router_set_enabled` with
   `{ "enabled": false }`.
2. Present its confirmation text to the user.
3. For the rest of this session, do **not** call `router_delegate` — handle tasks
   on the host model yourself unless the user runs `/tokenmaxed-on`.
