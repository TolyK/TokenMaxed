---
description: Set up TokenMaxed on this machine — create the ~/.tokenmaxed config from starter templates, check the secret scanner, and explain how to enable workers and the review gate.
disable-model-invocation: true
---

# /tokenmaxed:setup

1. Call the MCP tool `mcp__plugin_tokenmaxed_tokenmaxed__router_setup` (no
   arguments). It creates `~/.tokenmaxed/lanes.yaml` and `policy.yaml` from
   starter templates if they don't exist (it never overwrites), validates them,
   and reports status.
2. Present the status report to the user verbatim.
3. Then guide them through any next steps the report implies:
   - Edit `~/.tokenmaxed/lanes.yaml` to add/trust the lanes they want (provider
     CLIs like Codex/Gemini, a local Ollama, the cheaper-Claude lane, or a BYOK
     OpenAI-compatible worker).
   - For a BYOK `api` lane, set its key in the environment variable
     `TOKENMAXED_KEY_<authHandle>` (e.g. `TOKENMAXED_KEY_OPENAI`).
   - To allow untrusted worker lanes, install `gitleaks` and start Claude Code
     with `TOKENMAXED_GATE_READY=true`.
   - To turn on the turn-end review gate, set `TOKENMAXED_REVIEW_ON_STOP=true`.

Keep it concise and only mention the steps relevant to what the report showed.
