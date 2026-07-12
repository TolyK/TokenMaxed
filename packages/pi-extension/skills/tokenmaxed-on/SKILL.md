---
name: tokenmaxed-on
description: Turn TokenMaxed routing/offloading ON for this project (persisted). Re-enables delegating subtasks to cheaper capable lanes.
disable-model-invocation: true
---

# /skill:tokenmaxed-on

Enable TokenMaxed routing for this project:

1. Call the MCP tool `tokenmaxed_router_set_enabled` with
   `{ "enabled": true }`.
2. Present its confirmation text to the user.
