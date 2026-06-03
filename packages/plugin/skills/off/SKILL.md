---
description: Turn TokenMaxed routing/offloading OFF for this project (persisted). Claude stops delegating subtasks to other lanes for the rest of the session.
disable-model-invocation: true
---

# /tokenmaxed:off

Disable TokenMaxed routing for this project:

1. Call the MCP tool `mcp__plugin_tokenmaxed_tokenmaxed__router_set_enabled` with
   `{ "enabled": false }`.
2. Present its confirmation text to the user.
3. For the rest of this session, do **not** call `router_delegate` — handle tasks
   on the host model yourself unless the user runs `/tokenmaxed:on`.
