---
name: tokenmaxed-setup
description: Set up TokenMaxed on this machine — create the ~/.tokenmaxed config from starter templates, check the secret scanner, and explain how to enable workers and the review gate.
---

> **MANUAL-ONLY:** run this skill only when the user EXPLICITLY invokes it (e.g. `/<skill-name>`) or explicitly asks for exactly this action. Never auto-activate it from task matching.


# /tokenmaxed-setup

1. Call the MCP tool `mcp_tokenmaxed_router_setup` (no
   arguments). It creates `~/.tokenmaxed/lanes.yaml` and `policy.yaml` from
   starter templates if they don't exist (it never overwrites), validates them,
   and reports status.
2. Present the status report to the user verbatim.
3. **For every `api` lane in the report, ASK the user how it is billed — never assume.**
   An API endpoint is NOT inherently metered: many vendors (e.g. MiniMax) are accessed
   via a flat-rate **subscription token**. For each `api` lane, ask whether their access
   is:
   - a **subscription** (flat-rate / prepaid token, no per-task charge) → set
     `costBasis: subscription` in `~/.tokenmaxed/lanes.yaml` (treated as $0 and
     preferred by routing, like a CLI subscription — true to the premise of maximizing
     subscriptions), or
   - **metered** (pay-per-token) → set `costBasis: metered` (priced per token).

   Ask the user directly (one question per api lane, or one grouped question if
   there are several) and then edit `costBasis` in `lanes.yaml` to match their answer.
   This keeps the user from being mislabeled as metered when they are on a subscription.
4. Then guide them through any next steps the report implies:
   - Edit `~/.tokenmaxed/lanes.yaml` to add/trust the lanes they want (provider
     CLIs like Codex/Gemini, a local Ollama, the cheaper-Claude lane, or a BYOK
     OpenAI-compatible worker).
   - For a BYOK `api` lane, set its key in the environment variable
     `TOKENMAXED_KEY_<authHandle>` (e.g. `TOKENMAXED_KEY_OPENAI`).
   - To allow untrusted worker lanes, install `gitleaks` and start Hermes
     with `TOKENMAXED_GATE_READY=true`.
   - The turn-end review-iterate loop is **ON by default** whenever a usable
     reviewer (manager) lane exists — no flag needed. Opt out with
     `TOKENMAXED_REVIEW_ON_STOP=false`, or tune the rework-round bound with
     `TOKENMAXED_REVIEW_MAX_ROUNDS` (default 5).

Keep it concise and only mention the steps relevant to what the report showed.
