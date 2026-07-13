---
description: Set or clear capacity reservations for a lane or model in this project. Takes a lane ID or model name and a fraction (e.g. 15% or 0.15), or off/none/clear to clear.
---

# /tokenmaxed-reserve

Take the user's argument (everything after `/tokenmaxed-reserve`, trimmed).

- If the argument is empty, or equals `off`, `none`, or `clear` (case-insensitive), call
  `tokenmaxed_router_set_reserve` with `{}`. This clears all capacity reservations for this project.
- Otherwise, split the argument by whitespace into two parts: `<lane>` and `<fraction>`.
  - If only `<lane>` is provided:
    - If `<lane>` is `off`, `none`, or `clear` (case-insensitive), call `tokenmaxed_router_set_reserve` with `{}`.
    - Otherwise, call `tokenmaxed_router_set_reserve` with `{ "lane": "<lane>" }`. This clears the capacity reservation for that specific lane/model.
  - If both `<lane>` and `<fraction>` are provided:
    - If `<fraction>` is `off`, `none`, or `clear` (case-insensitive), call `tokenmaxed_router_set_reserve` with `{ "lane": "<lane>" }`.
    - Otherwise, call `tokenmaxed_router_set_reserve` with `{ "lane": "<lane>", "fraction": "<fraction>" }`. This sets the capacity reservation fraction for that lane/model.

After the tool returns, present its confirmation text to the user verbatim.

The capacity reservation is persisted per project and survives restarts; no relaunch is needed to turn it on or off. Run `/tokenmaxed-status` to see whether capacity reservations are active, or `/tokenmaxed-why <category>` to preview reservation pressure.
