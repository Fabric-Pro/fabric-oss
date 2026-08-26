-- Codex N2 (retry-idempotency): a stable per-dispatch-run occurrence key on the
-- suggestion cycle. If `client.workflow.start` succeeds but the dispatch
-- activity's COMPLETION is lost (worker crash after start, before reporting),
-- Temporal retries the activity. By then the generation workflow may have
-- terminalized the cycle (READY/etc.), so the active-`GENERATING` partial index
-- no longer recovers it → a bare create would spawn a SECOND cycle + workflow
-- (duplicate collectors + LLM spend). The occurrence key lets createOrGet reuse
-- the SAME cycle across retries regardless of terminal status.
--
-- Nullable: existing rows and manually-created cycles carry no key and are
-- unaffected. The unique index is PARTIAL (WHERE "occurrenceKey" IS NOT NULL) so
-- multiple NULL-key rows are allowed; only non-null keys dedupe per project.
ALTER TABLE "publishing_suggestion_cycle" ADD COLUMN "occurrenceKey" TEXT;

CREATE UNIQUE INDEX "publishing_suggestion_cycle_occurrence"
  ON "publishing_suggestion_cycle" ("projectId", "occurrenceKey")
  WHERE "occurrenceKey" IS NOT NULL;
