---
"fabric-app": patch
---

An "Indexing your repository" notice in the create-document dialog now clears on its own once indexing finishes.

Fizzy #1930 staging QA follow-up. Document generators whose only source is the repository report indexing as a SOFT_BLOCK with a WAIT remedy (so pasted source text can lift it), but the gates query polled only while a gate's state was PROCESSING, so the banner stayed up until a reload. Polling now also runs while any gate carries a WAIT remedy. Pinned by capability-gates.test.tsx "re-reads a soft block that is waiting on a job" (fails with the old predicate).
