---
name: tokenmaxed-until
description: Set or clear pacing targets for a lane or model in this project. Takes a lane ID or model name and a target date/time, or off/none/clear to clear.
---

> **MANUAL-ONLY:** run this skill only when the user EXPLICITLY invokes it (e.g. `/<skill-name>`) or explicitly asks for exactly this action. Never auto-activate it from task matching.


# /tokenmaxed-until

Before invoking the tool, the agent MUST normalize any natural-language target time ("Monday 9am", "tomorrow", "in 3 days", etc.) to an absolute ISO-8601 datetime string (using the current date it knows). The tool accepts only absolute ISO-8601 datetime strings.

Take the user's argument (everything after `/tokenmaxed-until`, trimmed).

- If the argument is empty, or equals `off`, `none`, or `clear` (case-insensitive), call
  `mcp_tokenmaxed_router_set_target` with `{}`. This clears all pacing targets for this project.
- Otherwise, split the argument by whitespace into two parts: `<lane>` and `<until>`.
  - If only `<lane>` is provided:
    - If `<lane>` is `off`, `none`, or `clear` (case-insensitive), call `mcp_tokenmaxed_router_set_target` with `{}`.
    - Otherwise, call `mcp_tokenmaxed_router_set_target` with `{ "lane": "<lane>" }`. This clears the pacing target for that specific lane/model.
  - If both `<lane>` and `<until>` are provided:
    - If `<until>` is `off`, `none`, or `clear` (case-insensitive), call `mcp_tokenmaxed_router_set_target` with `{ "lane": "<lane>" }`.
    - Otherwise, call `mcp_tokenmaxed_router_set_target` with `{ "lane": "<lane>", "until": "<until>" }` (where `<until>` is normalized to ISO-8601). This sets the pacing target datetime for that lane/model.

After the tool returns, present its confirmation text to the user verbatim.

The pacing target is persisted per project and survives restarts; no relaunch is needed. Run `/tokenmaxed-status` to see whether targets are active, or `/tokenmaxed-why <category>` to preview target pacing pressure.
