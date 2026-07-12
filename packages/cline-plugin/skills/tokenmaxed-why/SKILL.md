---
name: tokenmaxed-why
description: Preview which lane would handle a task category (and why) under the current lanes + policy — no execution, no content sent. Argument — a task category.
---

> **MANUAL-ONLY:** run this skill only when the user EXPLICITLY invokes it (e.g. `/<skill-name>`) or explicitly asks for exactly this action. Never auto-activate it from task matching.


# /tokenmaxed-why

Explain the routing decision for a task category by calling the MCP tool
`tokenmaxed__router_preview` (this only previews — it
executes nothing and sends no content anywhere).

Arguments provided by the user: `$ARGUMENTS`

1. Determine the task category from the arguments. Valid categories:
   `boilerplate`, `bugfix`, `refactor`, `explain`, `feature`, `codegen`, `docs`.
   If none was given or it is not one of these, ask the user which category to
   preview (list the valid ones) and stop.
2. Call the tool with `{ "category": "<category>" }`. If the user also specified a
   repository class (`public`/`private`/`unknown`), content sensitivity
   (`normal`/`sensitive`/`unknown`), or that the safety gate is ready, pass them as
   `repo_class`, `sensitivity`, and `gate_ready` respectively.
3. Present the tool's text result **verbatim** (it names the chosen lane, the
   policy verdict, and the reason). Do not add commentary unless asked.
