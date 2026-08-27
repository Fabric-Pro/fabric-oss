---
"fabric-app": patch
---

Readiness checklist: a document being regenerated no longer disappears from the checklist, and a failed re-run no longer takes it away for good.

Reported from staging against a project that plainly had a PRD: the Documents tab showed it, the checklist offered "Create PRD" beside it. Refreshing the document is what did it.

Regeneration mutates the same document row rather than writing a new one — `markDocumentGenerationStarted` sets it GENERATING, and a run that dies leaves it FAILED. The readiness evidence read counted only COMPLETE/REVIEW, so a long-satisfied item dropped the moment its owner hit Refresh and stayed dropped once the run failed, even though the previous version was still on the row, still active, and still what retrieval reads.

The read now also counts a row mid-rerun that already holds content. An empty one still does not: a first-ever generation has produced nothing yet, which is exactly when the item should read In Progress rather than done. This is the same shape as the code-index read beside it keying on `lastFullIndexAt` rather than status, for the same reason — re-running something does not un-do what the project already has.

It cascades further than the one row: `business-case` and `proposal` are superseded by `prd`, `context-source` and `additional-context-sources` list it too, and `architecture` depends on it — so one status flip resurfaced several items and re-gated another. All of them are fixed by this read.

Not fixed here, and reported separately: the generation itself failed because a document that size exceeds `MAXIMAL_OUTPUT_TOKEN_CEILING` (32,768) on the fallback path in `project-document-generation.ts`. Raising that ceiling has provider-quota consequences its own comment spells out, so it is a decision rather than a drive-by.
