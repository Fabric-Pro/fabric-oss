---
"fabric-app": patch
---

A Notion page bound as a project's PRD source now reaches a terminal indexed state instead of sitting on "Pending" forever.

Fizzy #2228, R13. Diagnosis: the two bind procedures in
`packages/api/modules/projects/procedures/notion-prd/sync-notion-prd.ts`
(`syncPrdSourceProcedure`, `bindNotionPageProcedure`) embed the page inline via
`embedProjectContext` from `@repo/rag` rather than starting
`contextEmbeddingWorkflow`. That helper writes `qdrantId` and `embeddedAt` and
nothing else — the `extractionStatus` write lives in
`embedSingleContextActivity`, which the inline path never reaches. Neither
branch of either procedure (create, or update-an-existing-row) touched the
field, so a row holding several kilobytes of real text stayed on the schema
default `PENDING` for the life of the row. This has been true since the initial
commit; the file had not been modified since.

Nothing regressed the status afterwards — the only writers of `PENDING` after
creation are the FILE and URL resync paths — and no repair path reached these
rows either, because the bulk `contexts.embed` endpoint excludes
`type: "INTEGRATION"` outright. The visible harm is that readiness evidence
counts only `COMPLETED` context sources, so an indexed PRD counted for nothing,
and the context list showed "Pending" indefinitely. The archive export is
unaffected: it now keys off whether a row yields text, not its status.

The fix routes both call sites through a local helper whose contract mirrors
`embedSingleContextActivity`: a stored vector advances the row to `COMPLETED`
and clears any stale `extractionError`; a reported embedding failure records an
indexing failure naming the step that failed; a call that stored no vector
leaves the status alone, so "Ready" continues to mean a vector exists.

`packages/database/scripts/complete-embedded-integration-contexts.ts` repairs
rows written before the fix — INTEGRATION, still `PENDING`, with both
`qdrantId` and `embeddedAt` set and non-whitespace content. Idempotent,
dry-run by default, `--apply` to write.

Tests: 5 new in
`packages/api/modules/projects/procedures/notion-prd/__tests__/sync-notion-prd-extraction-status.test.ts`;
4 of them fail against the unfixed source.
