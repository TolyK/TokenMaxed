---
name: tokenmaxed-policy
description: Set or clear the per-project named routing policy for TokenMaxed routing. Takes one of the 4 policies (balanced, cheapest, preserve-frontier, reliable), or off/none/clear to reset to balanced.
disable-model-invocation: true
---

# /skill:tokenmaxed-policy

Take the user's argument (everything after `/skill:tokenmaxed-policy`, trimmed) as the policy name.

- If the argument is empty, or equals `off`, `none`, or `clear` (case-insensitive), call
  `tokenmaxed_router_set_policy` with `{}`. This resets the policy to default "balanced" behavior.
- Otherwise, call `tokenmaxed_router_set_policy` with
  `{ "policy": "<the policy the user gave>" }`. This sets that policy as the active one for this project.

After the tool returns, present its confirmation text to the user verbatim.
