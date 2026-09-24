-- Coding Instructions: repository sync (design 2026-09-23 §4).
--
-- Two new tables, four enums, and one nullable column on
-- "project_instruction_snapshot". No backfill: nothing has been synced yet.
--
-- RLS is applied out of band by `pnpm --filter @repo/database apply:rls`; the
-- registrations are in `scripts/apply-rls-direct.ts` (`user_owned` for both
-- tables) and are matched by `src/tenant-db.ts`, or the tables fail OPEN on
-- the tenant path.
--
-- The foreign keys below are declared on the two tables this migration
-- creates, so they validate against empty tables and take no lock worth
-- deferring. The only change to an existing table is the nullable
-- "syncRunKey" column, which is metadata-only in Postgres 11+. Its unique
-- index needs CONCURRENTLY and therefore its own migration (20260923130100).

-- CreateEnum
CREATE TYPE "ProjectInstructionSyncTrigger" AS ENUM ('MANUAL', 'POLL', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "ProjectInstructionSyncRunStatus" AS ENUM ('SUCCEEDED', 'UNCHANGED', 'NOT_PUBLISHED', 'REJECTED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ProjectInstructionSyncError" AS ENUM ('NOT_CONFIGURED', 'INTEGRATION_UNAVAILABLE', 'PERMISSION_DENIED', 'REF_MISSING', 'ROOT_MISSING', 'LIMITS_EXCEEDED', 'CLONE_FAILED', 'STORAGE_FAILED', 'CHILD_ABORTED', 'CONFIGURATION_CHANGED', 'TREE_REFUSED');

-- CreateEnum
CREATE TYPE "ProjectInstructionSyncPause" AS ENUM ('PERMISSION_REVOKED', 'REF_MISSING');

-- AlterTable
ALTER TABLE "project_instruction_snapshot" ADD COLUMN "syncRunKey" TEXT;

-- CreateTable
CREATE TABLE "project_instruction_repository_sync" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryIntegrationId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL DEFAULT '',
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "automaticPausedReason" "ProjectInstructionSyncPause",
    "automaticPausedAt" TIMESTAMP(3),
    "suppressedCommitSha" TEXT,
    "suppressedGeneration" INTEGER,
    "lastEvaluatedCommitSha" TEXT,
    "lastEvaluatedGeneration" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_instruction_repository_sync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_instruction_repository_sync_run" (
    "id" TEXT NOT NULL,
    "syncId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "trigger" "ProjectInstructionSyncTrigger" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "status" "ProjectInstructionSyncRunStatus",
    "error" "ProjectInstructionSyncError",
    "note" TEXT,
    "commitSha" TEXT,
    "snapshotId" TEXT,

    CONSTRAINT "project_instruction_repository_sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_instruction_repository_sync_projectId_key" ON "project_instruction_repository_sync"("projectId");

-- CreateIndex
CREATE INDEX "project_instruction_repository_sync_automatic_nextCheckAt_idx" ON "project_instruction_repository_sync"("automatic", "nextCheckAt");

-- CreateIndex
CREATE INDEX "project_instruction_repository_sync_organizationId_idx" ON "project_instruction_repository_sync"("organizationId");

-- CreateIndex
CREATE INDEX "project_instruction_repository_sync_userId_idx" ON "project_instruction_repository_sync"("userId");

-- CreateIndex
CREATE INDEX "project_instruction_repository_sync_integration_idx" ON "project_instruction_repository_sync"("repositoryIntegrationId");

-- CreateIndex
CREATE INDEX "project_instruction_repository_sync_run_syncId_startedAt_idx" ON "project_instruction_repository_sync_run"("syncId", "startedAt");

-- CreateIndex
CREATE INDEX "project_instruction_repository_sync_run_projectId_startedAt_idx" ON "project_instruction_repository_sync_run"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "project_instruction_repository_sync_run_organizationId_idx" ON "project_instruction_repository_sync_run"("organizationId");

-- CreateIndex
CREATE INDEX "project_instruction_repository_sync_run_userId_idx" ON "project_instruction_repository_sync_run"("userId");

-- AddForeignKey
ALTER TABLE "project_instruction_repository_sync" ADD CONSTRAINT "project_instruction_repository_sync_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_repository_sync" ADD CONSTRAINT "project_instruction_repository_sync_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_repository_sync" ADD CONSTRAINT "project_instruction_repository_sync_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_repository_sync" ADD CONSTRAINT "project_instruction_repository_sync_integration_fkey" FOREIGN KEY ("repositoryIntegrationId") REFERENCES "project_repository_integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_repository_sync_run" ADD CONSTRAINT "project_instruction_repository_sync_run_syncId_fkey" FOREIGN KEY ("syncId") REFERENCES "project_instruction_repository_sync"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_repository_sync_run" ADD CONSTRAINT "project_instruction_repository_sync_run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_repository_sync_run" ADD CONSTRAINT "project_instruction_repository_sync_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_repository_sync_run" ADD CONSTRAINT "project_instruction_repository_sync_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
