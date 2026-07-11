---
description: Have the configured trusted manager lane review the current working-tree changes (git diff) and return a verdict (pass / needs-rework / fail) with notes. No content is stored.
---

# /tokenmaxed-review

Run a manager review of the current changes:

1. Call the MCP tool `tokenmaxed_router_review` (no
   arguments). It diffs the working tree, sends the diff to the configured
   trusted manager lane, and returns a verdict with notes.
2. Present the tool's result to the user verbatim (verdict + notes).
3. If the verdict is `needs-rework` or `fail`, offer to address the reviewer's
   points; otherwise note that the review passed.

If the tool reports that no review ran (no changes, or no manager configured),
relay that and suggest configuring a manager lane (`manager_allowed: true` on a
trusted CLI/API lane) if appropriate.
