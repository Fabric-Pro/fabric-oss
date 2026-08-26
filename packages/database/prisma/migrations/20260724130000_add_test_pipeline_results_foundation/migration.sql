-- Card 1834: automated-test pipeline-result ingestion foundation.
-- Additive only. RLS policies for the two new tenant tables are applied
-- separately by scripts/apply-rls-direct.ts (both registered `user_owned`).

-- New result source for CI/pipeline-ingested results (not used in this migration,
-- so the ADD VALUE is transaction-safe on PG12+).
ALTER TYPE "result_source" ADD VALUE IF NOT EXISTS 'PIPELINE';

-- CreateTable
CREATE TABLE "test_pipeline_run" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "provider" TEXT NOT NULL,
    "externalRunId" TEXT NOT NULL,
    "pipelineName" TEXT,
    "branch" TEXT,
    "commitSha" TEXT,
    "runUrl" TEXT,
    "status" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "passedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "otherCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "test_pipeline_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_pipeline_sync_state" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "provider" TEXT NOT NULL,
    "pipelineKey" TEXT NOT NULL DEFAULT '',
    "lastRunExternalId" TEXT,
    "lastCommitSha" TEXT,
    "pageToken" TEXT,
    "lastFetchedAt" TIMESTAMP(3),
    "status" TEXT,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_pipeline_sync_state_pkey" PRIMARY KEY ("id")
);

-- AlterTable: link a run's per-case result events back to the run
ALTER TABLE "test_result_event" ADD COLUMN "pipelineRunId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "test_pipeline_run_projectId_provider_externalRunId_key" ON "test_pipeline_run"("projectId", "provider", "externalRunId");
CREATE INDEX "test_pipeline_run_projectId_startedAt_idx" ON "test_pipeline_run"("projectId", "startedAt" DESC);
CREATE UNIQUE INDEX "test_pipeline_sync_state_projectId_provider_pipelineKey_key" ON "test_pipeline_sync_state"("projectId", "provider", "pipelineKey");
CREATE INDEX "test_pipeline_sync_state_projectId_idx" ON "test_pipeline_sync_state"("projectId");
CREATE INDEX "test_result_event_pipelineRunId_idx" ON "test_result_event"("pipelineRunId");
CREATE INDEX "test_case_projectId_automationRef_idx" ON "test_case"("projectId", "automationRef");

-- AddForeignKey
ALTER TABLE "test_pipeline_run" ADD CONSTRAINT "test_pipeline_run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_pipeline_run" ADD CONSTRAINT "test_pipeline_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_pipeline_run" ADD CONSTRAINT "test_pipeline_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_pipeline_sync_state" ADD CONSTRAINT "test_pipeline_sync_state_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_pipeline_sync_state" ADD CONSTRAINT "test_pipeline_sync_state_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_pipeline_sync_state" ADD CONSTRAINT "test_pipeline_sync_state_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_result_event" ADD CONSTRAINT "test_result_event_pipelineRunId_fkey" FOREIGN KEY ("pipelineRunId") REFERENCES "test_pipeline_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
