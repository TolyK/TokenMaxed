---
name: tokenmaxed-config
description: Show or persist TokenMaxed feature settings (~/.tokenmaxed/settings.json) — the durable alternative to launch-time env flags. An env var always overrides a stored setting; the kill-switch, YOLO mode, and API keys stay env-only.
disable-model-invocation: true
---

# /skill:tokenmaxed-config

Usage: `/skill:tokenmaxed-config` · `/skill:tokenmaxed-config <key>` · `/skill:tokenmaxed-config <key> <value|clear>`

1. Parse the arguments: an optional `key` (one of `gate_ready`, `escalate`,
   `learn_capability`, `capability_prior`, `reader_egress`, `tiered`,
   `tier_floor`, `review_on_stop`, `review_max_rounds`) and an optional `value`
   (`true`/`false`, a number for `tier_floor` / `review_max_rounds`, or `clear`
   to remove the stored key).
2. Call the MCP tool `tokenmaxed_router_config` with
   whatever was provided (no arguments ⇒ list everything).
3. Present its text result to the user verbatim — it shows each setting's
   effective value, whether an env var or the settings file supplied it, and
   when a change takes effect (hooks/statusline immediately on their next run;
   routing flags at the next session).
