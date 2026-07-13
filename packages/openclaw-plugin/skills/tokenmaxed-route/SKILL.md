---
name: tokenmaxed-route
description: Use TokenMaxed to offload bounded, self-contained coding subtasks to a cheaper capable lane. Consider this when a step is well-specified and separable — boilerplate, code generation, docs, mechanical refactors, or an isolated bugfix — so the expensive main session is spent only where it adds value.
---

# TokenMaxed routing (advisory)

When a coding task contains a **bounded, self-contained subtask** that a cheaper
model could do well, consider offloading it instead of doing it on the main
(expensive) model.

How to offload:

1. Call the MCP tool `tokenmaxed__router_delegate` with the
   task `category` and a complete, self-contained `instruction`. Put **everything
   the lane needs inside the instruction text** — a lane receives nothing else
   beyond any files you pass in `files` (no repo, no tools).
   - **To stop the lane hallucinating repo facts it can't see** (model prices,
     enum values, a test-fixture call idiom), pass the relevant repo-relative
     paths in **`files`** — the file being edited, the registry/config it touches,
     the test fixtures. They're read VERBATIM (server-side, path-confined) and
     attached, so the lane copies real values instead of inventing them. Prefer
     naming the exact files over pasting paraphrased snippets. (Private-repo files
     only reach a reader-trust lane with reader egress enabled; otherwise they're
     dropped and the reply says so.)
   - **Always set `repo_class` and `sensitivity` honestly** so policy can apply:
     - public repo → `repo_class: "public"`; non-sensitive content → `sensitivity: "normal"`.
     - private repo → `repo_class: "private"`; secrets/proprietary/PII → `sensitivity: "sensitive"`.
   - This matters: when the repo is genuinely public and the content normal,
     passing `public`/`normal` lets cheaper worker lanes handle it; omitting them
     leaves the context unknown, and policy (deny-by-default) keeps the work on
     trusted/native lanes. When unsure, do **not** claim public/normal.
   - **Honor an explicit model choice.** When the USER names a model in their
     prompt ("use minimax for this", "route this to gpt-5.5", "have haiku do
     it"), pass it as **`model`** — routing then pins to the connected lane(s)
     serving that model. Pass the **vendor model id**, normalizing obvious
     colloquial names first ("ChatGPT 5.5" → `gpt-5.5`, "Haiku" →
     `claude-haiku`); both exact versioned ids and family names match,
     case-insensitively (a family name pins its concrete resolution). If the
     pin is refused as not connected, the reply lists the connected models —
     retry ONCE with the listed id when the user's intent maps to it
     unambiguously; otherwise relay the list and ask. If the model can't run
     under current gates, the task comes back native with the reason —
     TokenMaxed never substitutes a different model for an explicit pin, so
     relay that reason rather than silently picking another lane. Only set
     `model` when the user actually named one; never infer it.
   - **Full Repo Access Grant.** When the USER explicitly grants a named model
     full access to the repo for a task ("let minimax see the whole repo for this",
     "give gemini full access here"), pass **`full_access: true`** together with the
     **`model`** pin. Relay to the user that the grant is scoped to that one lane for
     this call, the fail-closed secret scanner is still enforced, and output remains
     reader-derived.
   - **Set `access_need` when you already know the task needs full access.** Leave
     it unset (or `auto`) for ordinary bounded subtasks — they try a worker, and a
     worker that turns out to need repo/tool context it can't see will hand the
     task back automatically (see below). Pass `access_need: "repo-tight"` to skip
     workers entirely for a task that plainly needs the live repo, shell, tools, or
     coordinated multi-file edits — it routes straight to a full-access lane. This
     is about *access*, separate from `repo_class`/`sensitivity` (data egress).
2. Read the tool's reply:
   - If it returns an **offloaded result**, use that result (review it as you
     would your own work before applying).
   - If it says **handle it yourself (native)** — because routing is disabled,
     policy blocked it, no cheaper lane qualified, a lane failed, or **a worker
     handed the task back for insufficient context** — just do the task yourself on
     the main model. On a give-back the reply's `reason`/result text names what the
     worker said it needed; use that as a hint for what to pull into context.

Good candidates: generating a boilerplate file, writing a pure function from a
clear spec, drafting docs, a localized refactor. Poor candidates: tasks needing
broad repo context, cross-file reasoning, or judgement about the whole change —
keep those on the main model (or mark them `access_need: "repo-tight"`).

Respect the toggle: if the user ran `/tokenmaxed_off`, do not offload. The user
can check state with `/tokenmaxed_status` and re-enable with `/tokenmaxed_on`.
