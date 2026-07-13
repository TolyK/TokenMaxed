---
name: tokenmaxed-backtest
description: Compare routing decisions of two policies (policyA vs policyB) over historical workload. Read-only.
---

# $tokenmaxed-backtest

Compare what different routing policies would do over your historical workload. Runs as a what-if over your current lane configuration and observed evidence by calling the MCP tool `tokenmaxed:router_backtest`.

Arguments:
- `policyA`: (Optional) The first policy to compare. Defaults to currently active policy.
- `policyB`: (Optional) The second policy to compare. Defaults to cheapest (or balanced if current is cheapest).
- `period`: (Optional) The history window, e.g. "7d", "24h", or "all".

Instructions:
1. Parse policy names and period if provided.
2. Call the tool with the arguments `{ "policyA": ..., "policyB": ..., "period": ... }`.
3. Render the output verbatim.
