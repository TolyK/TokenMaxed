---
name: tokenmaxed-prefer
description: Set or clear the per-project preferred lane for TokenMaxed routing. Takes a lane id to prefer, or off/none/clear to clear.
---

> **MANUAL-ONLY:** run this skill only when the user EXPLICITLY invokes it (e.g. `/<skill-name>`) or explicitly asks for exactly this action. Never auto-activate it from task matching.


# /tokenmaxed-prefer

Take the user's argument (everything after `/tokenmaxed-prefer`, trimmed) as the lane id.

- If the argument is empty, or equals `off`, `none`, or `clear` (case-insensitive), call
  `tokenmaxed__router_set_prefer` with `{}`. This clears any
  preferred lane and returns TokenMaxed to normal capability-ranked routing.
- Otherwise, call `tokenmaxed__router_set_prefer` with
  `{ "lane": "<the lane id the user gave>" }`. This sets that lane as the preferred one
  for this project.

After the tool returns, present its confirmation text to the user verbatim.

Note: the preferred lane is honored only when that lane is eligible, available, and
capable for a given task. If it is not, routing falls back to the normal capability
ranking, and `/tokenmaxed-why` (or `router_preview`) will show what was actually picked.
The preference is persisted per project and survives restarts; no relaunch is needed to
turn it on or off.
