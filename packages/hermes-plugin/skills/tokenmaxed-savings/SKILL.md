---
name: tokenmaxed-savings
description: Show TokenMaxed savings (frontier-equivalent and metered spend avoided) from the local content-free ledger. Optional argument — a period like 7d, 24h, or all.
---

> **MANUAL-ONLY:** run this skill only when the user EXPLICITLY invokes it (e.g. `/<skill-name>`) or explicitly asks for exactly this action. Never auto-activate it from task matching.


# /tokenmaxed-savings

Report routing savings by calling the MCP tool
`mcp_tokenmaxed_router_savings`.

Arguments provided by the user: `$ARGUMENTS`

1. If the arguments contain a period (e.g. `7d`, `24h`, or `all`), call the tool
   with `{ "period": "<that value>" }`. Otherwise call it with no arguments
   (defaults to all time).
2. Present the tool's text result to the user **verbatim** — it is already
   formatted. Do not add analysis or commentary unless the user asks.

If the tool returns an error (for example a missing ledger), show the error
message plainly and suggest running some routed work first.
