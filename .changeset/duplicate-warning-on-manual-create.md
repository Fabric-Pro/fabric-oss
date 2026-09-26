---
"fabric-app": patch
---

Creating a work item from the roadmap now checks it against existing items first, and warns before creating a likely duplicate so it can be merged into the existing one instead.

Fizzy #2180. Manual creation through the roadmap "Add" dialog previously skipped the duplicate-detection pass that the feature-proposal review flow already ran; both now share one decision engine (`packages/temporal/src/lib/backlog-routing-core.ts`) so the same corpus, embedding cache, and judge/decision-model resolution back both surfaces. A new `projects.stories.checkDuplicate` procedure runs the check against the typed description before creation; on a likely match the dialog replaces the form with a warning step showing the matched item, confidence, and reasoning, with options to merge into the existing item, dismiss and create anyway, or go back and edit. The check never blocks creation: a failure, timeout, or usage-limit rejection falls through to the unchanged create path with one calm note that the item could not be checked.
