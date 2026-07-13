---
name: tokenmaxed-plan
description: Suggest portfolio/lane improvements based on your routed-share history. Read-only.
---

# $tokenmaxed-plan

Optimize subscription and lane portfolios based on routed usage history by calling the MCP tool
`tokenmaxed:router_plan`.

Arguments provided by the user: `$ARGUMENTS`

1. If the arguments contain a period (e.g. `7d`, `24h`, or `all`), call the tool
   with `{ "period": "<that value>" }`. Otherwise call it with no arguments.
2. Present the tool's text result to the user **verbatim** — it is already
   formatted. Do not add analysis or commentary unless the user asks.

If the tool returns an error, show the error message plainly.
