-- Living Memory: sync selected paths from a repository (design 2026-09-23
-- §4, Fizzy #2657).
--
-- Three enums, two new tables and one nullable column on "project_context".
-- No backfill: nothing has been synced yet, so every existing row keeps
-- "repositorySyncId" NULL and stays an ordinary (unmanaged) row.
--
-- "project_context_repository_sync_run" has deliberately NO foreign key to
-- "project_context_repository_sync": a run receipt outlives a disconnect, so
-- "syncId" is a plain column.
--
-- RLS is applied out of band by `pnpm --filter @repo/database apply:rls`; the
-- registrations are in `scripts/apply-rls-direct.ts` (`user_owned` for both
-- tables) and are matched by `src/tenant-db.ts`, or the tables fail OPEN on
-- the tenant path.
--
-- The only changes to existing tables are two nullable columns, each
-- metadata-only in Postgres 11+, and one foreign key. On "project_context":
-- "repositorySyncId" and its foreign key, added NOT VALID so it takes no scan
-- of "project_context" under lock. It is enforced for every row written from
-- now on; every existing row is NULL, which a foreign key never checks. Its
-- VALIDATE is declared in prisma/pending-constraint-validations.json. The
-- ("projectId", "repositorySyncId") index needs CONCURRENTLY and therefore
-- its own migration (20260923150100).
--
-- On "project_context_pending_vector_cleanup": "syncRunKey", the run key of
-- the sync run whose prune queued the record (NULL for every other delete),
-- so a run's receipt counts its still-queued cleanups live, whichever drain
-- clears them. No foreign key. Its index needs CONCURRENTLY and therefore its
-- own migration (20260923150200).

-- CreateEnum
CREATE TYPE "ProjectContextSyncTrigger" AS ENUM ('MANUAL');

-- CreateEnum
CREATE TYPE "ProjectContextSyncRunStatus" AS ENUM ('SUCCEEDED', 'PARTIAL', 'UNCHANGED', 'FAILED');

-- CreateEnum
CREATE TYPE "ProjectContextSyncError" AS ENUM ('NOT_CONFIGURED', 'INTEGRATION_UNAVAILABLE', 'PERMISSION_DENIED', 'RUN_IN_PROGRESS', 'REF_MISSING', 'PATHS_MISSING', 'LIMITS_EXCEEDED', 'CLONE_FAILED', 'STORE_FAILED', 'CONFIGURATION_CHANGED', 'SUPERSEDED', 'INTERRUPTED');

-- AlterTable
ALTER TABLE "project_context" ADD COLUMN     "repositorySyncId" TEXT;

-- AlterTable
ALTER TABLE "project_context_pending_vector_cleanup" ADD COLUMN     "syncRunKey" TEXT;

-- CreateTable
CREATE TABLE "project_context_repository_sync" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryIntegrationId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "paths" TEXT[],
    "generation" INTEGER NOT NULL DEFAULT 1,
    "activeRunKey" TEXT,
    "lastAppliedCommitSha" TEXT,
    "lastAppliedRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_context_repository_sync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_context_repository_sync_run" (
    "id" TEXT NOT NULL,
    "syncId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "context" JSONB NOT NULL,
    "trigger" "ProjectContextSyncTrigger" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "status" "ProjectContextSyncRunStatus",
    "error" "ProjectContextSyncError",
    "commitSha" TEXT,
    "plan" JSONB,
    "outcomes" JSONB NOT NULL DEFAULT '{}',
    "removedCount" INTEGER NOT NULL DEFAULT 0,
    "pruneConflicts" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "project_context_repository_sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_context_repository_sync_projectId_key" ON "project_context_repository_sync"("projectId");

-- CreateIndex
CREATE INDEX "project_context_repository_sync_organizationId_idx" ON "project_context_repository_sync"("organizationId");

-- CreateIndex
CREATE INDEX "project_context_repository_sync_userId_idx" ON "project_context_repository_sync"("userId");

-- CreateIndex
CREATE INDEX "project_context_repository_sync_integration_idx" ON "project_context_repository_sync"("repositoryIntegrationId");

-- CreateIndex
CREATE INDEX "project_context_repository_sync_run_projectId_startedAt_idx" ON "project_context_repository_sync_run"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "project_context_repository_sync_run_syncId_finishedAt_idx" ON "project_context_repository_sync_run"("syncId", "finishedAt");

-- CreateIndex
CREATE INDEX "project_context_repository_sync_run_organizationId_idx" ON "project_context_repository_sync_run"("organizationId");

-- CreateIndex
CREATE INDEX "project_context_repository_sync_run_userId_idx" ON "project_context_repository_sync_run"("userId");

-- AddForeignKey
ALTER TABLE "project_context" ADD CONSTRAINT "project_context_repositorySyncId_fkey" FOREIGN KEY ("repositorySyncId") REFERENCES "project_context_repository_sync"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "project_context_repository_sync" ADD CONSTRAINT "project_context_repository_sync_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_repository_sync" ADD CONSTRAINT "project_context_repository_sync_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_repository_sync" ADD CONSTRAINT "project_context_repository_sync_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_repository_sync" ADD CONSTRAINT "project_context_repository_sync_integration_fkey" FOREIGN KEY ("repositoryIntegrationId") REFERENCES "project_repository_integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_repository_sync_run" ADD CONSTRAINT "project_context_repository_sync_run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_repository_sync_run" ADD CONSTRAINT "project_context_repository_sync_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_repository_sync_run" ADD CONSTRAINT "project_context_repository_sync_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

