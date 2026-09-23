---
"fabric-app": patch
---

A document created from pasted text no longer leaves its project showing "Processing your sources" and "Add context" in progress.

Creating a document as-is keeps the pasted text as a context row linked to the document. Nothing embeds it, so it stays PENDING for good, and both the capability-gate evidence and the readiness evidence counted it as a source in flight. On staging (Fizzy #1930 round-3 QA) a project with zero context showed the Context tab's "Processing your sources", the auto-refresh "Sources are still processing" warning, and readiness "In progress" indefinitely. Once the stall clock ran out, the gate would have turned into "A source stopped processing". Both queries now exclude rows that back an imported document.
