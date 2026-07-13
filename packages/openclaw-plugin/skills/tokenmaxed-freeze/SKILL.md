---
name: tokenmaxed-freeze
description: Turn TokenMaxed capability outcome learning FREEZE on or off for this project. Takes on/off (default on).
disable-model-invocation: true
---

# /tokenmaxed_freeze

Freeze or unfreeze TokenMaxed capability outcome learning for this project. When frozen, accumulated outcome learning is paused, and routing falls back to declared/prior capability without recent outcomes.

Take the user's argument (everything after `/tokenmaxed_freeze`, trimmed, case-insensitive):

- If the argument is empty, or equals `on`, `yes`, or `enable`, call
  `tokenmaxed__router_set_freeze` with `{ "enabled": true }`.
- If the argument equals `off`, `no`, or `disable`, call
  `tokenmaxed__router_set_freeze` with `{ "enabled": false }`.

After the tool returns, present its confirmation text to the user verbatim.
