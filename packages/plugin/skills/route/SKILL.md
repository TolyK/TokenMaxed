---
description: Use TokenMaxed to offload bounded, self-contained coding subtasks to a cheaper capable lane. Consider this when a step is well-specified and separable — boilerplate, code generation, docs, mechanical refactors, or an isolated bugfix — so the expensive main session is spent only where it adds value.
---

# TokenMaxed routing (advisory)

When a coding task contains a **bounded, self-contained subtask** that a cheaper
model could do well, consider offloading it instead of doing it on the main
(expensive) model.

How to offload:

1. Call the MCP tool `mcp__plugin_tokenmaxed_tokenmaxed__router_delegate` with the
   task `category` and a complete, self-contained `instruction`. Put **everything
   the lane needs inside the instruction text** — an untrusted lane receives
   nothing else (no repo, no files, no tools).
   - **Always set `repo_class` and `sensitivity` honestly** so policy can apply:
     - public repo → `repo_class: "public"`; non-sensitive content → `sensitivity: "normal"`.
     - private repo → `repo_class: "private"`; secrets/proprietary/PII → `sensitivity: "sensitive"`.
   - This matters: when the repo is genuinely public and the content normal,
     passing `public`/`normal` lets cheaper worker lanes handle it; omitting them
     leaves the context unknown, and policy (deny-by-default) keeps the work on
     trusted/native lanes. When unsure, do **not** claim public/normal.
2. Read the tool's reply:
   - If it returns an **offloaded result**, use that result (review it as you
     would your own work before applying).
   - If it says **handle it yourself (native)** — because routing is disabled,
     policy blocked it, no cheaper lane qualified, or a lane failed — just do the
     task yourself on the main model.

Good candidates: generating a boilerplate file, writing a pure function from a
clear spec, drafting docs, a localized refactor. Poor candidates: tasks needing
broad repo context, cross-file reasoning, or judgement about the whole change —
keep those on the main model.

Respect the toggle: if the user ran `/tokenmaxed:off`, do not offload. The user
can check state with `/tokenmaxed:status` and re-enable with `/tokenmaxed:on`.
