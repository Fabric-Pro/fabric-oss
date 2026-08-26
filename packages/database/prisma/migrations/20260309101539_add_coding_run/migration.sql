-- CreateEnum
CREATE TYPE "CodingRunStatus" AS ENUM ('QUEUED', 'STARTING', 'RUNNING', 'AWAITING_REVIEW', 'PR_OPENED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CodingRunProvider" AS ENUM ('BACKGROUND_AGENTS');

-- DropForeignKey (safe: use IF EXISTS)
ALTER TABLE IF EXISTS "public"."principal_role" DROP CONSTRAINT IF EXISTS "principal_role_assignedById_fkey";
ALTER TABLE IF EXISTS "public"."principal_role" DROP CONSTRAINT IF EXISTS "principal_role_organizationApiKeyId_fkey";
ALTER TABLE IF EXISTS "public"."principal_role" DROP CONSTRAINT IF EXISTS "principal_role_organizationId_fkey";
ALTER TABLE IF EXISTS "public"."principal_role" DROP CONSTRAINT IF EXISTS "principal_role_registeredAgentId_fkey";
ALTER TABLE IF EXISTS "public"."principal_role" DROP CONSTRAINT IF EXISTS "principal_role_roleId_fkey";
ALTER TABLE IF EXISTS "public"."principal_role" DROP CONSTRAINT IF EXISTS "principal_role_userId_fkey";
ALTER TABLE IF EXISTS "public"."role" DROP CONSTRAINT IF EXISTS "role_organizationId_fkey";
ALTER TABLE IF EXISTS "public"."role_permission" DROP CONSTRAINT IF EXISTS "role_permission_permissionKey_fkey";
ALTER TABLE IF EXISTS "public"."role_permission" DROP CONSTRAINT IF EXISTS "role_permission_roleId_fkey";

-- AlterTable
ALTER TABLE "session" DROP COLUMN IF EXISTS "permissions";

-- DropTable
DROP TABLE IF EXISTS "public"."permission";
DROP TABLE IF EXISTS "public"."principal_role";
DROP TABLE IF EXISTS "public"."role";
DROP TABLE IF EXISTS "public"."role_permission";

-- CreateTable
CREATE TABLE "coding_run" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "storyTaskId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "provider" "CodingRunProvider" NOT NULL DEFAULT 'BACKGROUND_AGENTS',
    "providerSessionId" TEXT,
    "status" "CodingRunStatus" NOT NULL DEFAULT 'QUEUED',
    "repositoryUrl" TEXT,
    "repositoryOwner" TEXT,
    "repositoryName" TEXT,
    "targetBranch" TEXT,
    "pullRequestUrl" TEXT,
    "pullRequestNumber" INTEGER,
    "pullRequestBranch" TEXT,
    "promptText" TEXT,
    "workflowId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coding_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coding_run_event" (
    "id" TEXT NOT NULL,
    "codingRunId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "providerEventId" TEXT,
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coding_run_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coding_run_projectId_idx" ON "coding_run"("projectId");

-- CreateIndex
CREATE INDEX "coding_run_storyId_idx" ON "coding_run"("storyId");

-- CreateIndex
CREATE INDEX "coding_run_storyTaskId_idx" ON "coding_run"("storyTaskId");

-- CreateIndex
CREATE INDEX "coding_run_userId_idx" ON "coding_run"("userId");

-- CreateIndex
CREATE INDEX "coding_run_organizationId_idx" ON "coding_run"("organizationId");

-- CreateIndex
CREATE INDEX "coding_run_status_idx" ON "coding_run"("status");

-- CreateIndex
CREATE INDEX "coding_run_event_codingRunId_idx" ON "coding_run_event"("codingRunId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "project_userId_draftKey_composite_idx" ON "project"("userId", "draftKey", "organizationId");

-- AddForeignKey
ALTER TABLE "coding_run" ADD CONSTRAINT "coding_run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coding_run" ADD CONSTRAINT "coding_run_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coding_run" ADD CONSTRAINT "coding_run_storyTaskId_fkey" FOREIGN KEY ("storyTaskId") REFERENCES "story_task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coding_run" ADD CONSTRAINT "coding_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coding_run" ADD CONSTRAINT "coding_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coding_run_event" ADD CONSTRAINT "coding_run_event_codingRunId_fkey" FOREIGN KEY ("codingRunId") REFERENCES "coding_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
