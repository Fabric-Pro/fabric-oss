-- Read-access grants on a project's coding-instructions repository (spec
-- 2026-11-04 §4.4, §4.5): one row per member Fabric gave access to, so a
-- revoke reverses only what Fabric granted.
--
-- Additive: two enums and one new, empty table with its indexes and foreign
-- keys. No backfill.
--
-- RLS: scripts/apply-rls-direct.ts registers the table (user_owned), and
-- src/tenant-db.ts registers the model.

-- CreateEnum
CREATE TYPE "ProjectInstructionsAccessMode" AS ENUM ('TEAM', 'COLLABORATOR');

-- CreateEnum
CREATE TYPE "ProjectInstructionsAccessStatus" AS ENUM ('INVITED', 'ACTIVE', 'FAILED', 'REVOKED');

-- CreateTable
CREATE TABLE "project_instructions_access_grant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "teamSlug" TEXT,
    "mode" "ProjectInstructionsAccessMode" NOT NULL,
    "status" "ProjectInstructionsAccessStatus" NOT NULL,
    "lastError" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_instructions_access_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_instructions_access_grant_organizationId_idx" ON "project_instructions_access_grant"("organizationId");

-- CreateIndex
CREATE INDEX "project_instructions_access_grant_userId_idx" ON "project_instructions_access_grant"("userId");

-- CreateIndex
CREATE INDEX "project_instructions_access_grant_createdByUserId_idx" ON "project_instructions_access_grant"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "project_instructions_access_grant_projectId_userId_key" ON "project_instructions_access_grant"("projectId", "userId");

-- AddForeignKey
ALTER TABLE "project_instructions_access_grant" ADD CONSTRAINT "project_instructions_access_grant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instructions_access_grant" ADD CONSTRAINT "project_instructions_access_grant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instructions_access_grant" ADD CONSTRAINT "project_instructions_access_grant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_instructions_access_grant" ADD CONSTRAINT "project_instructions_access_grant_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
