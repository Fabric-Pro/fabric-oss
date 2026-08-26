-- Per-batch staging for a Fabric-dispatched run (spec F3 — durable batching).
--
-- A run's results belong in `test_result_event` + `test_agentic_step_log`, both
-- created by `ingestPipelineRun`. That helper creates ONE pipeline run per
-- (projectId, provider, externalRunId) and is idempotent on it, so calling it
-- per batch would make every batch after the first a no-op or a
-- delete-and-recreate, destroying the earlier batches' detail. Batches therefore
-- need somewhere else to write, and this is it: rows land as each batch
-- finishes, and a single reconciling ingest drains them when the last one
-- completes.
--
-- Tenant columns are denormalized from the parent run (which copies them from
-- the project), matching `test_agentic_run`, so the same `user_owned` RLS policy
-- applies without a parent walk.
CREATE TABLE "test_agentic_case_result" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "failureMessage" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "modelCalls" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT,
    "steps" JSONB NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_agentic_case_result_pkey" PRIMARY KEY ("id")
);

-- One row per case per run. This is what makes a batch write idempotent under
-- Temporal's activity retry, which would otherwise double-count a case whose
-- write committed and whose acknowledgement was lost.
CREATE UNIQUE INDEX "test_agentic_case_result_runId_testCaseId_key"
    ON "test_agentic_case_result"("runId", "testCaseId");
CREATE INDEX "test_agentic_case_result_runId_idx"
    ON "test_agentic_case_result"("runId");

ALTER TABLE "test_agentic_case_result" ADD CONSTRAINT "test_agentic_case_result_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "test_agentic_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_agentic_case_result" ADD CONSTRAINT "test_agentic_case_result_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_agentic_case_result" ADD CONSTRAINT "test_agentic_case_result_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_agentic_case_result" ADD CONSTRAINT "test_agentic_case_result_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
