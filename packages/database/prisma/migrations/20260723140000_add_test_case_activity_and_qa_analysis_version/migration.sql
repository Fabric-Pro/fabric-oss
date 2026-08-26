-- Card 1639 history: per-case edit audit + QA analysis version snapshots.
--
-- `test_case_activity` is the non-result half of the per-case Activity timeline
-- (result runs already live in `test_result_event`); `qa_analysis_version` keeps
-- every QA-analysis generation so the QA tab can show and compare prior runs
-- (the current analysis still lives on `user_story.qaAnalysis`).
--
-- Both are columnless children that inherit tenancy from a parent (test_case /
-- project) — RLS policies are added by scripts/apply-rls-direct.ts, matching the
-- `test_result_event` / `story_priority_change` conventions.

-- CreateEnum
CREATE TYPE "TestCaseActivityType" AS ENUM ('CREATED', 'STATE_CHANGED', 'PRIORITY_CHANGED', 'RENAMED', 'STEPS_CHANGED', 'AUTOMATION_CHANGED', 'PM_LINK_CHANGED');

-- CreateTable
CREATE TABLE "test_case_activity" (
    "id" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "type" "TestCaseActivityType" NOT NULL,
    "actorUserId" TEXT,
    "actorLabel" TEXT,
    "fromValue" TEXT,
    "toValue" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_case_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qa_analysis_version" (
    "id" TEXT NOT NULL,
    "userStoryId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "depth" TEXT NOT NULL,
    "specHash" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "generatedByUserId" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qa_analysis_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "test_case_activity_testCaseId_occurredAt_idx" ON "test_case_activity"("testCaseId", "occurredAt");

-- CreateIndex
CREATE INDEX "qa_analysis_version_userStoryId_generatedAt_idx" ON "qa_analysis_version"("userStoryId", "generatedAt");

-- CreateIndex
CREATE INDEX "qa_analysis_version_projectId_idx" ON "qa_analysis_version"("projectId");

-- AddForeignKey
ALTER TABLE "test_case_activity" ADD CONSTRAINT "test_case_activity_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "test_case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_activity" ADD CONSTRAINT "test_case_activity_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_analysis_version" ADD CONSTRAINT "qa_analysis_version_userStoryId_fkey" FOREIGN KEY ("userStoryId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_analysis_version" ADD CONSTRAINT "qa_analysis_version_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_analysis_version" ADD CONSTRAINT "qa_analysis_version_generatedByUserId_fkey" FOREIGN KEY ("generatedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: give every existing test case a CREATED activity so its timeline is
-- never empty. actorUserId is the recorded creator; occurredAt is the case's
-- creation time. AI-vs-manual provenance for historical rows is not reliably
-- recoverable (the draft-job ledger is prunable), so historical CREATED events
-- carry no actorLabel — only rows created from this change onward distinguish
-- an AI drafter. Soft-deleted cases are skipped (their timeline is unreachable).
INSERT INTO "test_case_activity" ("id", "testCaseId", "type", "actorUserId", "occurredAt", "createdAt")
SELECT
    'tca_' || substr(md5(random()::text || tc."id"), 1, 21),
    tc."id",
    'CREATED'::"TestCaseActivityType",
    tc."createdById",
    tc."createdAt",
    CURRENT_TIMESTAMP
FROM "test_case" tc
WHERE tc."deletedAt" IS NULL;
