---
name: tokenmaxed-calibrate
description: Set or clear manual used-fraction calibrations for a lane or model in this project. Takes a lane ID or model name and a fraction (e.g. 70% or 0.7), or off/none/clear to clear.
---

> **MANUAL-ONLY:** run this skill only when the user EXPLICITLY invokes it (e.g. `/<skill-name>`) or explicitly asks for exactly this action. Never auto-activate it from task matching.


# /tokenmaxed-calibrate

Take the user's argument (everything after `/tokenmaxed-calibrate`, trimmed).

- If the argument is empty, or equals `off`, `none`, or `clear` (case-insensitive), call
  `mcp_tokenmaxed_router_set_calibration` with `{}`. This clears all manual quota calibrations for this project.
- Otherwise, split the argument by whitespace into two parts: `<lane>` and `<fraction>`.
  - If only `<lane>` is provided:
    - If `<lane>` is `off`, `none`, or `clear` (case-insensitive), call `mcp_tokenmaxed_router_set_calibration` with `{}`.
    - Otherwise, call `mcp_tokenmaxed_router_set_calibration` with `{ "lane": "<lane>" }`. This clears the manual quota calibration for that specific lane/model.
  - If both `<lane>` and `<fraction>` are provided:
    - If `<fraction>` is `off`, `none`, or `clear` (case-insensitive), call `mcp_tokenmaxed_router_set_calibration` with `{ "lane": "<lane>" }`.
    - Otherwise, call `mcp_tokenmaxed_router_set_calibration` with `{ "lane": "<lane>", "fraction": "<fraction>" }`. This sets the manual quota calibration fraction for that lane/model.

After the tool returns, present its confirmation text to the user verbatim.

The manual quota calibration is persisted per project and survives restarts; no relaunch is needed to turn it on or off. Run `/tokenmaxed-status` to see whether manual calibrations are active, or `/tokenmaxed-why <category>` to preview calibration pressure.
