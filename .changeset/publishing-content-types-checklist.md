---
"fabric-app": patch
---

Make content types a setting on the topic's first tab, not a question behind a modal

Two complaints from the card owner, one control (Fizzy #1851): *"its simple setting, not question, it could be checkbox"*, and *"i dont think modal is a good fit here, maybe it could be just list with checkboxes"*.

Which formats to produce is now an inline checklist at the top of Summary & Questions, above the questions and below the summary — it is the first decision anyone makes about a topic, and every question under it is downstream of the answer. It used to live behind a dialog on a metadata row two tabs away.

The analysis's reasoning sits **on** the choice, grouped by the verdict it reached, rather than being re-asked underneath it. A format the analysis deferred is still selectable: the classification is advice, and a setting whose options the AI can veto is not a setting. The list is collapsed once a choice exists, with the answer on the header, so a decision already taken does not occupy a screen of space above the ones that still need one.

**And the CONTENT_TYPE questions are gone.** "Should we produce a LinkedIn Post for this topic?" was this checkbox wearing a question's clothes — and it was also one of the two producers asking about the same format twice. The generator no longer mints them, a model-authored one is dropped, and topics created before the change have theirs filtered out of the panel rather than migrated: the rows stay in the Decision Log, where an answer someone actually gave is still part of the record. The now-unreachable Yes/No branch has been removed with them.
