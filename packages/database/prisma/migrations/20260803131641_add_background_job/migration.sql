-- CreateEnum
CREATE TYPE "BackgroundJobKind" AS ENUM ('TEAMS_CHANNEL_MONITOR', 'TEAMS_CHAT_MONITOR', 'SLACK_CHANNEL_MONITOR', 'SLACK_BACKFILL', 'CODE_INDEXING', 'CONTEXT_PROCESSING');

-- CreateEnum
CREATE TYPE "BackgroundJobStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "background_job" (
    "id" TEXT NOT NULL,
    "kind" "BackgroundJobKind" NOT NULL,
    "status" "BackgroundJobStatus" NOT NULL DEFAULT 'RUNNING',
    "title" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "errorClass" TEXT,
    "workflowId" TEXT NOT NULL,
    "runId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "background_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "background_job_organizationId_createdAt_idx" ON "background_job"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "background_job_userId_createdAt_idx" ON "background_job"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "background_job_workflowId_idx" ON "background_job"("workflowId");

-- CreateIndex
CREATE INDEX "background_job_status_heartbeatAt_idx" ON "background_job"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "background_job_projectId_idx" ON "background_job"("projectId");

-- AddForeignKey
ALTER TABLE "background_job" ADD CONSTRAINT "background_job_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "background_job" ADD CONSTRAINT "background_job_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "background_job" ADD CONSTRAINT "background_job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique index: at most one OPEN (RUNNING) job per (workflow, source).
-- Not expressible in the Prisma schema, same as the Notification live-unread
-- dedupe index. This is what lets Temporal activities upsert their job row
-- concurrently without duplicating it — the loser of the race gets a P2002 and
-- adopts the winner's row.
--
-- Keyed on the PAIR, not workflowId alone, because workflow ids are reused:
-- channel monitors keep a stable id across ticks (and emit one row per channel),
-- and per-repo code indexing reuses its id across runs (TERMINATE_EXISTING).
-- COALESCE maps the NULL sourceId of single-source workflows onto one slot.
CREATE UNIQUE INDEX "background_job_workflow_source_running_uq"
    ON "background_job"("workflowId", COALESCE("sourceId", ''))
    WHERE status = 'RUNNING';
