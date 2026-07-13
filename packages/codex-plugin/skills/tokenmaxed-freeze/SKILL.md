---
name: tokenmaxed-freeze
description: Turn TokenMaxed capability outcome learning FREEZE on or off for this project. Takes on/off (default on).
---

# $tokenmaxed-freeze

Freeze or unfreeze TokenMaxed capability outcome learning for this project. When frozen, accumulated outcome learning is paused, and routing falls back to declared/prior capability without recent outcomes.

Take the user's argument (everything after `$tokenmaxed-freeze`, trimmed, case-insensitive):

- If the argument is empty, or equals `on`, `yes`, or `enable`, call
  `tokenmaxed:router_set_freeze` with `{ "enabled": true }`.
- If the argument equals `off`, `no`, or `disable`, call
  `tokenmaxed:router_set_freeze` with `{ "enabled": false }`.

After the tool returns, present its confirmation text to the user verbatim.
