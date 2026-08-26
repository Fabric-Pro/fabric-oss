-- Durable background drafting of test cases with AI.
--
-- Schema delta:
--   * TestCaseDraftJobStatus (new) — lifecycle of one drafting run.
--   * test_case_draft_job (new) — the run ledger. Drafting is a chain of LLM
--     calls, so it runs in a Temporal workflow rather than on the request
--     thread; this row is what makes the run durable (survives reload / tab
--     close / logout) and rediscoverable (the client re-finds an in-flight run
--     by querying the project, never by remembering a workflow id).
--     `createdCaseIds` records exactly which cases a run produced, so a finished
--     batch stays addressable without a denormalized column on every test_case.
--     Tenant columns are denormalized from the parent project, mirroring
--     test_case; RLS is applied by apply-rls-direct.ts ("user_owned").
--   * NotificationType += TEST_CASES_DRAFTED (additive — existing consumers
--     ignore unknown enum values). Written by the drafting workflow's finalize
--     activity when a run reaches a terminal state; reuses the PROJECT category.

-- CreateEnum
CREATE TYPE "TestCaseDraftJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- AlterEnum
-- `IF NOT EXISTS` keeps the ADD VALUE idempotent across half-applied deploys.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TEST_CASES_DRAFTED';

-- CreateTable
CREATE TABLE "test_case_draft_job" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "requestedById" TEXT NOT NULL,
    "status" "TestCaseDraftJobStatus" NOT NULL DEFAULT 'PENDING',
    "storyIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "totalFeatures" INTEGER NOT NULL DEFAULT 0,
    "processedFeatures" INTEGER NOT NULL DEFAULT 0,
    "createdCaseIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "featureOutcomes" JSONB,
    "error" TEXT,
    "workflowId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_case_draft_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "test_case_draft_job_projectId_requestedById_startedAt_idx" ON "test_case_draft_job"("projectId", "requestedById", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "test_case_draft_job_projectId_status_idx" ON "test_case_draft_job"("projectId", "status");

-- CreateIndex
CREATE INDEX "test_case_draft_job_userId_idx" ON "test_case_draft_job"("userId");

-- CreateIndex
CREATE INDEX "test_case_draft_job_organizationId_idx" ON "test_case_draft_job"("organizationId");

-- AddForeignKey
ALTER TABLE "test_case_draft_job" ADD CONSTRAINT "test_case_draft_job_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_draft_job" ADD CONSTRAINT "test_case_draft_job_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_draft_job" ADD CONSTRAINT "test_case_draft_job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_draft_job" ADD CONSTRAINT "test_case_draft_job_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
