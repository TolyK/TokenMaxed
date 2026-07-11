---
name: tokenmaxed-yolo
description: Turn TokenMaxed YOLO mode ON or OFF for this project — the --dangerously-skip-permissions analogue that bypasses ALL trust/egress gates so every configured worker/reader lane becomes selectable. Takes on/off (default on).
---

# $tokenmaxed-yolo

YOLO mode is the TokenMaxed equivalent of Claude Code's `--dangerously-skip-permissions` (Codex analogue: `--sandbox danger-full-access`):
when ON, the router forces **every trust and data-egress gate open**, so ALL configured
worker/reader lanes are selectable regardless of `repo_class`, sensitivity, the
gate-ready / reader-egress opt-ins, or per-lane attestation. This means (possibly
private) repository code may be sent to ANY configured vendor lane. It does **not**
disable the secret scanner, an explicit policy `block` rule, the `disabledLaneIds`
list, or the user-owned-config / RCE guard.

Take the user's argument (everything after `$tokenmaxed-yolo`, trimmed, case-insensitive):

- If the argument is empty, or equals `on`, `yes`, or `enable`, call
  `tokenmaxed:router_set_yolo` with `{ "enabled": true }`.
- If the argument equals `off`, `no`, `disable`, `clear`, or `none`, call
  `tokenmaxed:router_set_yolo` with `{ "enabled": false }`.

After the tool returns, present its confirmation text to the user **verbatim** — it
carries the safety warning. The setting is persisted per project and survives restarts;
the `TOKENMAXED_DISABLE` kill-switch always overrides it back off. Run
`$tokenmaxed-status` to see whether YOLO is currently on, or `$tokenmaxed-why <category>`
to preview which (now ungated) lane a task would route to.
