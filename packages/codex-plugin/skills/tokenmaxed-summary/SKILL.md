---
name: tokenmaxed-summary
description: Show the TokenMaxed session summary — token usage and metered $ avoided over 24h/7d/lifetime, your configured lanes (trust/role + live availability), and the active reviewer. Read-only; nothing is sent anywhere.
---

# $tokenmaxed-summary

Show the at-a-glance TokenMaxed summary by calling the MCP tool
`tokenmaxed:router_summary` (no arguments).

1. Call the tool.
2. Present its text result to the user **verbatim** — it is already formatted
   (headline savings, 24h/7d/lifetime windows, and the lane/reviewer line). Do not
   add analysis unless the user asks.

If the tool returns an error (e.g. no config yet), show the message plainly and
suggest running `$tokenmaxed-setup`.
