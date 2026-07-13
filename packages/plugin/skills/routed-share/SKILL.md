---
description: Set or clear the estimated fraction of your work for a lane or model name that is routed through TokenMaxed. Used only to estimate total usage. Use a percentage (0<..100) or a decimal (0<..1), or off/none/clear to clear.
disable-model-invocation: true
---

# /tokenmaxed:routed-share

Take the user's argument (everything after `/tokenmaxed:routed-share`, trimmed).

- If the argument is empty, or equals `off`, `none`, or `clear` (case-insensitive), call
  `mcp__plugin_tokenmaxed_tokenmaxed__router_set_routed_share` with `{}`. This clears all manual routed shares for this project.
- Otherwise, split the argument by whitespace into two parts: `<lane>` and `<share>`.
  - If only `<lane>` is provided:
    - If `<lane>` is `off`, `none`, or `clear` (case-insensitive), call `mcp__plugin_tokenmaxed_tokenmaxed__router_set_routed_share` with `{}`.
    - Otherwise, call `mcp__plugin_tokenmaxed_tokenmaxed__router_set_routed_share` with `{ "lane": "<lane>" }`. This clears the manual routed share for that specific lane/model.
  - If both `<lane>` and `<share>` are provided:
    - If `<share>` is `off`, `none`, or `clear` (case-insensitive), call `mcp__plugin_tokenmaxed_tokenmaxed__router_set_routed_share` with `{ "lane": "<lane>" }`.
    - Otherwise, call `mcp__plugin_tokenmaxed_tokenmaxed__router_set_routed_share` with `{ "lane": "<lane>", "share": "<share>" }`. This sets the manual routed share fraction for that lane/model.

After the tool returns, present its confirmation text to the user verbatim.

The manual routed share is persisted per project and survives restarts; no relaunch is needed to turn it on or off. Run `/tokenmaxed:status` to see whether manual routed shares are active, or `/tokenmaxed:why <category>` to preview its impact on estimates.
