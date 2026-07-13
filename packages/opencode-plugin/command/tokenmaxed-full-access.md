---
description: Grant or revoke full repo access for a named model's reader lane in this project — the scoped, per-lane alternative to YOLO. Takes a model name to grant, or off/none/clear (optionally with a model) to revoke.
---

# /tokenmaxed-full-access

Grant a SPECIFIC reader-trust lane full access to this repo — the scoped, per-lane
alternative to `/tokenmaxed-yolo`. When granted, that reader lane becomes selectable
regardless of `repo_class`/sensitivity and receives the **full, unminimized** repository
context (instead of the scrubbed/bounded reader payload), so it is no longer "blind to
the repo." The fail-closed **secret scanner still applies** (a detected secret blocks
egress), the output is flagged **reader-derived**, and an explicit policy `block` rule or
the `disabledLaneIds` list still drop the lane. Persisted per project; survives restarts.

Take the user's argument (everything after `/tokenmaxed-full-access`, trimmed, case-insensitive):

- If it begins with `off`, `none`, `clear`, `revoke`, or `remove`:
  - With a trailing model name (e.g. `off minimax`): call
    `tokenmaxed_router_set_full_access` with
    `{ "model": "<that model>", "off": true }` to revoke just that grant.
  - With nothing after it: call the tool with `{ "off": true }` to clear ALL grants for
    this project.
- Otherwise, treat the whole argument as the model name/id to grant and call the tool with
  `{ "model": "<the model>" }`. Normalize an obvious colloquial name to the vendor id
  first (e.g. "MiniMax" → minimax); the tool resolves it to the concrete connected reader
  lane(s) and stores their lane ids.

After the tool returns, present its confirmation text to the user **verbatim** — for a grant or single revocation, it names the exact lane(s) affected and restates the secret-scanner / reader-derived guarantees (for a clear-all, it confirms all grants were cleared). If
the grant matches no connected reader lane, relay the tool's list of connectable reader
models. Use `/tokenmaxed-status` or `/tokenmaxed-why <category>` to see the effect.
