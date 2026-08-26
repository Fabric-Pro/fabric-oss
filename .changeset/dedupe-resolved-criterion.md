---
"fabric-app": patch
---

Re-drafting test cases no longer duplicates cases when the model spells the same criterion differently

The re-draft duplicate check keyed criterion references by their raw text, while the drafting prompt invites free-text spellings ("AC 3", "criterion 3", "AC 3 (retry policy)") — so each novel spelling of an already-covered criterion re-created a near-identical case, plus its embedding, on every subsequent draft. Keys now follow the same first-integer rule the traceability resolver uses, so spellings that resolve to one criterion deduplicate as one, and references nothing can resolve share the unnamed bucket.
