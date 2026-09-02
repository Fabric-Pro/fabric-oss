---
"fabric-app": patch
---

Mark a decision that is missing its type or duration, so a failed AI tagging cannot hide

Closes the last open gap from the Fizzy #2029 audit. Capture through the form
now enforces a type and a duration, but a decision extracted from a meeting is
tagged by a model call afterwards, and a call that fails leaves the draft
untagged permanently.

Capture deliberately does not depend on the model succeeding — a transcript
conversion that failed because the AI was down would be a worse product than an
untagged draft — and there is no honest value to fall back on when the model
returns nothing. Inventing a duration, or minting a placeholder type, would put
fabricated classification into the log and pollute the project's taxonomy.

So the guarantee on that path is visibility rather than enforcement: a decision
missing either field carries a "Needs classification" badge everywhere decisions
are summarised, which is what stops one from reading as a decision nobody needed
to classify. The reasoning is recorded at the capture call site so the next
person does not "fix" it by adding a fallback value.
