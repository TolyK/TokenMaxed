---
name: tokenmaxed-policy
description: Set or clear the per-project named routing policy for TokenMaxed routing. Takes one of the 4 policies (balanced, cheapest, preserve-frontier, reliable), or off/none/clear to reset to balanced.
---

> **MANUAL-ONLY:** run this skill only when the user EXPLICITLY invokes it (e.g. `/<skill-name>`) or explicitly asks for exactly this action. Never auto-activate it from task matching.


# /tokenmaxed-policy

Take the user's argument (everything after `/tokenmaxed-policy`, trimmed) as the policy name.

- If the argument is empty, or equals `off`, `none`, or `clear` (case-insensitive), call
  `tokenmaxed__router_set_policy` with `{}`. This resets the policy to default "balanced" behavior.
- Otherwise, call `tokenmaxed__router_set_policy` with
  `{ "policy": "<the policy the user gave>" }`. This sets that policy as the active one for this project.

After the tool returns, present its confirmation text to the user verbatim.
