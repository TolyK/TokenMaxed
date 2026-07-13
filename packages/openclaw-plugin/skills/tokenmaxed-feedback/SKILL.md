---
name: tokenmaxed-feedback
description: Record user feedback on routing/offload quality (good, wrong-model, bad-output, too-slow) to adapt routing.
disable-model-invocation: true
---

# /tokenmaxed_feedback

Record direct user feedback on TokenMaxed routing or offload quality. Opinions are marked as user feedback and feed learned capabilities exactly like manager reviews.

Take the user's argument (everything after `/tokenmaxed_feedback`, trimmed, case-insensitive):

- Map the argument to one of the valid verdicts: `good`, `wrong-model`, `bad-output`, or `too-slow`.
- If the argument is a valid verdict, call `tokenmaxed__router_feedback` with `{ "verdict": "<verdict>" }`.
- If the argument is invalid, inform the user of the allowed verdicts: `good`, `wrong-model`, `bad-output`, or `too-slow`.

After the tool returns, present its confirmation text to the user verbatim.
