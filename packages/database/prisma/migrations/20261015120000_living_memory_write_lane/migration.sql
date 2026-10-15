-- Living Memory write lane, configuration and receipts (ADR-022).
--
-- Four enums and three new tables: the write folders an administrator names
-- inside a project's repository sync ("project_context_write_target"), the
-- receipt of each admitted write ("project_memory_write") and the paths of
-- that write ("project_memory_write_entry"). Nothing existing is altered and
-- nothing is backfilled: no project has a write folder yet, and nothing reads
-- or writes these tables until the write workflow lands. Dropping the three
-- tables and the four enums undoes the migration.
--
-- "project_memory_write" has deliberately NO foreign key to
-- "project_context_write_target": a receipt outlives its folder and its sync,
-- so "targetId" is a plain column, as "syncId" is on
-- "project_context_repository_sync_run". "directPushEnabledById" is a plain
-- column for the same reason: the record outlives the member's account.
--
-- RLS is applied out of band by `pnpm --filter @repo/database apply:rls`; the
-- registrations are in `scripts/apply-rls-direct.ts` (`user_owned` for the
-- target and the receipt, `memory_write_parent` for the entry, which carries
-- no tenant columns and inherits its write's) and are matched by
-- `src/tenant-db.ts`, or the tables fail OPEN on the tenant path.

-- CreateEnum
CREATE TYPE "ProjectContextWriteMode" AS ENUM ('PULL_REQUEST', 'DIRECT_PUSH');

-- CreateEnum
CREATE TYPE "ProjectMemoryWriteStatus" AS ENUM ('PENDING', 'COMMITTED', 'PULL_REQUEST', 'CONFLICT', 'REFUSED', 'FAILED');

-- CreateEnum
CREATE TYPE "ProjectMemoryWriteVia" AS ENUM ('MCP', 'CLI');

-- CreateEnum
CREATE TYPE "ProjectMemoryWriteOp" AS ENUM ('PUT', 'DELETE');

-- CreateTable
CREATE TABLE "project_context_write_target" (
    "id" TEXT NOT NULL,
    "syncId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "mode" "ProjectContextWriteMode" NOT NULL DEFAULT 'PULL_REQUEST',
    "directPushEnabledById" TEXT,
    "directPushEnabledAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_context_write_target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_memory_write" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetVersion" INTEGER NOT NULL,
    "folder" TEXT NOT NULL,
    "mode" "ProjectContextWriteMode" NOT NULL,
    "ref" TEXT NOT NULL,
    "repositoryIntegrationId" TEXT NOT NULL,
    "oauthClientId" TEXT,
    "via" "ProjectMemoryWriteVia" NOT NULL,
    "message" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "status" "ProjectMemoryWriteStatus" NOT NULL DEFAULT 'PENDING',
    "outcome" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "project_memory_write_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_memory_write_entry" (
    "id" TEXT NOT NULL,
    "writeId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "op" "ProjectMemoryWriteOp" NOT NULL,
    "ifMatchOid" TEXT,
    "stagedKey" TEXT,
    "bytes" INTEGER,
    "sha256" TEXT,

    CONSTRAINT "project_memory_write_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_context_write_target_projectId_idx" ON "project_context_write_target"("projectId");

-- CreateIndex
CREATE INDEX "project_context_write_target_organizationId_idx" ON "project_context_write_target"("organizationId");

-- CreateIndex
CREATE INDEX "project_context_write_target_userId_idx" ON "project_context_write_target"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_context_write_target_syncId_folder_key" ON "project_context_write_target"("syncId", "folder");

-- CreateIndex
CREATE INDEX "project_memory_write_projectId_createdAt_idx" ON "project_memory_write"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "project_memory_write_userId_digest_createdAt_idx" ON "project_memory_write"("userId", "digest", "createdAt");

-- CreateIndex
CREATE INDEX "project_memory_write_organizationId_idx" ON "project_memory_write"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "project_memory_write_entry_writeId_path_key" ON "project_memory_write_entry"("writeId", "path");

-- AddForeignKey
ALTER TABLE "project_context_write_target" ADD CONSTRAINT "project_context_write_target_syncId_fkey" FOREIGN KEY ("syncId") REFERENCES "project_context_repository_sync"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_write_target" ADD CONSTRAINT "project_context_write_target_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_write_target" ADD CONSTRAINT "project_context_write_target_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_write_target" ADD CONSTRAINT "project_context_write_target_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_memory_write" ADD CONSTRAINT "project_memory_write_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_memory_write" ADD CONSTRAINT "project_memory_write_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_memory_write" ADD CONSTRAINT "project_memory_write_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_memory_write_entry" ADD CONSTRAINT "project_memory_write_entry_writeId_fkey" FOREIGN KEY ("writeId") REFERENCES "project_memory_write"("id") ON DELETE CASCADE ON UPDATE CASCADE;
