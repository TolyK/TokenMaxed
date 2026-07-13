---
description: Record user feedback on routing/offload quality (good, wrong-model, bad-output, too-slow) to adapt routing.
---

# /tokenmaxed-feedback

Record direct user feedback on TokenMaxed routing or offload quality. Opinions are marked as user feedback and feed learned capabilities exactly like manager reviews.

Take the user's argument (everything after `/tokenmaxed-feedback`, trimmed, case-insensitive):

- Map the argument to one of the valid verdicts: `good`, `wrong-model`, `bad-output`, or `too-slow`.
- If the argument is a valid verdict, call `tokenmaxed_router_feedback` with `{ "verdict": "<verdict>" }`.
- If the argument is invalid, inform the user of the allowed verdicts: `good`, `wrong-model`, `bad-output`, or `too-slow`.

After the tool returns, present its confirmation text to the user verbatim.
