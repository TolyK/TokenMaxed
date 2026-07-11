---
description: Show TokenMaxed token usage from the local ledger, grouped by model or lane. Optional arguments — a period like 7d/24h/all, and "by lane" or "by model".
---

# /tokenmaxed-tokens

Report token usage by calling the MCP tool
`tokenmaxed_router_tokens`.

Arguments provided by the user: `$ARGUMENTS`

1. Build the tool arguments from what the user asked:
   - If a period is present (`7d`, `24h`, `all`), pass it as `period`.
   - If the user asked to group "by lane", pass `{ "by": "lane" }`; if "by model"
     (the default), pass `{ "by": "model" }` or omit it.
   - If nothing was specified, call with no arguments (all time, by model).
2. Present the tool's text result **verbatim**. Do not add commentary unless asked.

If the tool returns an error, show the message plainly.
