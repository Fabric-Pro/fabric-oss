-- CreateEnum
CREATE TYPE "test_case_state" AS ENUM ('DRAFT', 'READY', 'CLOSED');

-- CreateEnum
CREATE TYPE "test_case_priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "automation_status" AS ENUM ('NOT_AUTOMATED', 'PLANNED', 'AUTOMATED');

-- CreateEnum
CREATE TYPE "test_plan_state" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterEnum
ALTER TYPE "pm_state_change_entity_type" ADD VALUE 'TEST_CASE';

-- AlterEnum
ALTER TYPE "ProjectContextType" ADD VALUE 'TEST_CASE';

-- CreateTable
CREATE TABLE "test_case" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "identifier" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "state" "test_case_state" NOT NULL DEFAULT 'DRAFT',
    "priority" "test_case_priority" NOT NULL DEFAULT 'MEDIUM',
    "ownerId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "automationStatus" "automation_status" NOT NULL DEFAULT 'NOT_AUTOMATED',
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "externalId" TEXT,
    "externalUrl" TEXT,
    "externalMcpServerId" TEXT,
    "pmAutoSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedPmHash" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastPmSyncStatus" "pm_sync_status",
    "lastPmSyncError" VARCHAR(500),
    "lastPmSyncAttemptAt" TIMESTAMP(3),
    "contextId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "test_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_case_step" (
    "id" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "action" TEXT NOT NULL,
    "expected" TEXT NOT NULL,
    "data" JSONB,
    "sharedStepId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_case_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_plan" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "state" "test_plan_state" NOT NULL DEFAULT 'ACTIVE',
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "test_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_plan_case" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "section" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_plan_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_case_work_item_link" (
    "id" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "userStoryId" TEXT NOT NULL,
    "acceptanceCriterionRef" TEXT,
    "linkType" TEXT NOT NULL DEFAULT 'TESTS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_case_work_item_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "test_case_projectId_idx" ON "test_case"("projectId");

-- CreateIndex
CREATE INDEX "test_case_userId_idx" ON "test_case"("userId");

-- CreateIndex
CREATE INDEX "test_case_organizationId_idx" ON "test_case"("organizationId");

-- CreateIndex
CREATE INDEX "test_case_projectId_state_idx" ON "test_case"("projectId", "state");

-- CreateIndex
CREATE INDEX "test_case_projectId_deletedAt_idx" ON "test_case"("projectId", "deletedAt");

-- CreateIndex
CREATE INDEX "test_case_externalMcpServerId_idx" ON "test_case"("externalMcpServerId");

-- CreateIndex
CREATE UNIQUE INDEX "test_case_projectId_identifier_key" ON "test_case"("projectId", "identifier");

-- CreateIndex
CREATE INDEX "test_case_step_testCaseId_idx" ON "test_case_step"("testCaseId");

-- CreateIndex
CREATE INDEX "test_plan_projectId_idx" ON "test_plan"("projectId");

-- CreateIndex
CREATE INDEX "test_plan_userId_idx" ON "test_plan"("userId");

-- CreateIndex
CREATE INDEX "test_plan_organizationId_idx" ON "test_plan"("organizationId");

-- CreateIndex
CREATE INDEX "test_plan_projectId_deletedAt_idx" ON "test_plan"("projectId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "test_plan_projectId_identifier_key" ON "test_plan"("projectId", "identifier");

-- CreateIndex
CREATE INDEX "test_plan_case_planId_idx" ON "test_plan_case"("planId");

-- CreateIndex
CREATE INDEX "test_plan_case_testCaseId_idx" ON "test_plan_case"("testCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "test_plan_case_planId_testCaseId_key" ON "test_plan_case"("planId", "testCaseId");

-- CreateIndex
CREATE INDEX "test_case_work_item_link_testCaseId_idx" ON "test_case_work_item_link"("testCaseId");

-- CreateIndex
CREATE INDEX "test_case_work_item_link_userStoryId_idx" ON "test_case_work_item_link"("userStoryId");

-- CreateIndex
CREATE UNIQUE INDEX "test_case_work_item_link_testCaseId_userStoryId_key" ON "test_case_work_item_link"("testCaseId", "userStoryId");

-- AddForeignKey
ALTER TABLE "test_case" ADD CONSTRAINT "test_case_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case" ADD CONSTRAINT "test_case_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case" ADD CONSTRAINT "test_case_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_step" ADD CONSTRAINT "test_case_step_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "test_case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_plan" ADD CONSTRAINT "test_plan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_plan" ADD CONSTRAINT "test_plan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_plan" ADD CONSTRAINT "test_plan_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_plan_case" ADD CONSTRAINT "test_plan_case_planId_fkey" FOREIGN KEY ("planId") REFERENCES "test_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_plan_case" ADD CONSTRAINT "test_plan_case_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "test_case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_work_item_link" ADD CONSTRAINT "test_case_work_item_link_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "test_case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_work_item_link" ADD CONSTRAINT "test_case_work_item_link_userStoryId_fkey" FOREIGN KEY ("userStoryId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex (manual): partial unique on (projectId, externalId) WHERE externalId IS NOT NULL.
-- Prisma's @@unique cannot emit a filtered (partial) index, so it is hand-written here
-- (mirrors user_story_projectId_externalId_key). Guarantees one Fabric test case per remote
-- PM item while still allowing many local cases with externalId = NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "test_case_projectId_externalId_key"
    ON "test_case" ("projectId", "externalId")
    WHERE "externalId" IS NOT NULL;
