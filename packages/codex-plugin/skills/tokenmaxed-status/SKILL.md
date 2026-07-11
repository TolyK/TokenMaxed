---
name: tokenmaxed-status
description: Show whether TokenMaxed routing is enabled for this project, and check enabled API lanes for a stale pinned model (makes a provider /models call — key only, no repo/task content — and updates the local freshness cache; routing is never changed).
---

# $tokenmaxed-status

1. Call the MCP tool `tokenmaxed:router_status` (no
   arguments).
2. Present its text result to the user verbatim — it shows the enabled/disabled
   state and any stale pinned models (with the newer version available).
