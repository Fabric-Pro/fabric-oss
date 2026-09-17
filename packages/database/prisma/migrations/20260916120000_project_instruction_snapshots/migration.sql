-- Coding Instructions: project instruction snapshots and files.
--
-- Two new tables and two columns on "project". A snapshot is one immutable
-- upload of a project's coding-agent instruction tree; files are indexed here
-- and their bytes live in object storage. The composite FK from file to
-- snapshot carries projectId so a file can never point at another project's
-- snapshot.
--
-- RLS is applied out of band by `pnpm --filter @repo/database apply:rls`; the
-- registrations are in `scripts/apply-rls-direct.ts` (`user_owned` for both
-- tables) and must be matched by `src/tenant-db.ts`, or the table fails OPEN on
-- the tenant path.
--
-- "project" is pre-existing, so its two changes are split by lock weight,
-- following the shape 20260828130000/130100/130200 used for
-- decision_log_entry.supersedesId:
--
--   The unique index for "publishedInstructionSnapshotId" is a separate
--   migration (20260916120100), CONCURRENTLY, because CREATE UNIQUE INDEX on an
--   existing table must run CONCURRENTLY and therefore cannot share a
--   transaction with DDL.
--
--   The foreign key below is added NOT VALID and validated in 20260916120200.
--   A plain ADD CONSTRAINT ... FOREIGN KEY validates against every existing row
--   while holding a lock; NOT VALID takes that scan off this migration. Nothing
--   can actually violate it — the column is created empty by the ALTER TABLE
--   below — but the scan still reads every page of "project", which is on the
--   request path.

-- CreateEnum
CREATE TYPE "ProjectInstructionSource" AS ENUM ('UPLOAD', 'REPOSITORY');

-- CreateEnum
CREATE TYPE "ProjectInstructionSnapshotStatus" AS ENUM ('RECEIVING', 'VALIDATING', 'READY', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ProjectInstructionFileKind" AS ENUM ('SKILL', 'AGENT', 'RULE', 'INSTRUCTIONS', 'SETTINGS', 'SCRIPT', 'KNOWLEDGE', 'OTHER');

-- CreateTable
CREATE TABLE "project_instruction_snapshot" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" "ProjectInstructionSource" NOT NULL,
    "status" "ProjectInstructionSnapshotStatus" NOT NULL DEFAULT 'RECEIVING',
    "rejection" JSONB,
    "settingsFrozen" JSONB NOT NULL,
    "publishOnReady" BOOLEAN NOT NULL DEFAULT true,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "storedBytes" INTEGER NOT NULL DEFAULT 0,
    "excludedCount" INTEGER NOT NULL DEFAULT 0,
    "digest" TEXT,
    "repositoryIntegrationId" TEXT,
    "sourceRef" TEXT,
    "sourceCommitSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "readyAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "project_instruction_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_instruction_file" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "kind" "ProjectInstructionFileKind" NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "storageKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "isText" BOOLEAN NOT NULL,
    "mode" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_instruction_file_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "instructionSettings" JSONB,
ADD COLUMN     "publishedInstructionSnapshotId" TEXT;

-- CreateIndex
CREATE INDEX "project_instruction_snapshot_projectId_status_idx" ON "project_instruction_snapshot"("projectId", "status");

-- CreateIndex
CREATE INDEX "project_instruction_snapshot_organizationId_idx" ON "project_instruction_snapshot"("organizationId");

-- CreateIndex
CREATE INDEX "project_instruction_snapshot_userId_idx" ON "project_instruction_snapshot"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "project_instruction_snapshot_id_projectId_key" ON "project_instruction_snapshot"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_instruction_snapshot_projectId_version_key" ON "project_instruction_snapshot"("projectId", "version");

-- CreateIndex
CREATE INDEX "project_instruction_file_projectId_idx" ON "project_instruction_file"("projectId");

-- CreateIndex
CREATE INDEX "project_instruction_file_organizationId_idx" ON "project_instruction_file"("organizationId");

-- CreateIndex
CREATE INDEX "project_instruction_file_userId_idx" ON "project_instruction_file"("userId");

-- CreateIndex
CREATE INDEX "project_instruction_file_snapshotId_kind_idx" ON "project_instruction_file"("snapshotId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "project_instruction_file_snapshotId_path_key" ON "project_instruction_file"("snapshotId", "path");

-- AddForeignKey
ALTER TABLE "project_instruction_snapshot" ADD CONSTRAINT "project_instruction_snapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_snapshot" ADD CONSTRAINT "project_instruction_snapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_snapshot" ADD CONSTRAINT "project_instruction_snapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_file" ADD CONSTRAINT "project_instruction_file_snapshotId_projectId_fkey" FOREIGN KEY ("snapshotId", "projectId") REFERENCES "project_instruction_snapshot"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_file" ADD CONSTRAINT "project_instruction_file_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instruction_file" ADD CONSTRAINT "project_instruction_file_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- migration-lint: allow unvalidated-constraint — the constraint IS added NOT
-- VALID; the rule's matcher does not see the trailing marker on this statement,
-- the same blind spot 20260828130000_decision_log_supersedes carries the
-- identical allow for. 20260916120200_project_instruction_snapshots_fk_validate
-- validates it under a weaker lock in this same changeset, so nothing is left
-- unvalidated and no pending-constraint-validations.json entry is owed.
ALTER TABLE "project" ADD CONSTRAINT "project_publishedInstructionSnapshotId_fkey" FOREIGN KEY ("publishedInstructionSnapshotId") REFERENCES "project_instruction_snapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
