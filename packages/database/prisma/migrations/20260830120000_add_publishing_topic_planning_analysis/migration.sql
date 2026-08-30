-- Publishing Suite Phase 2A-2 (Fizzy #1851): the AI-generated pre-draft planning
-- worksheet for one publishing topic.
--
-- Hand-authored rather than generated, because three of the things this table
-- needs cannot be expressed in the Prisma schema — the partial unique index and
-- the two CHECK constraints at the bottom. They are documented on the model too.
--
-- The table is new and carries no rows, so every constraint validates
-- immediately and NOT VALID is unnecessary. There is deliberately no
-- `SET LOCAL row_security = off` anywhere in this file: an unguarded one blocked
-- every staging deploy once already, and this migration does not need it.
--
-- RLS is NOT applied here. In this repository row-level security lives in
-- `scripts/apply-rls-direct.ts` and is applied out of band by
-- `pnpm --filter @repo/database apply:rls`; the sibling
-- `20260714065955_add_publishing_suite` migration contains no policy either.
-- The registration for this table is in that script.

-- CreateEnum
CREATE TYPE "PublishingPlanningAnalysisStatus" AS ENUM ('GENERATING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "publishing_topic_planning_analysis" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "version" INTEGER NOT NULL,
    "status" "PublishingPlanningAnalysisStatus" NOT NULL DEFAULT 'GENERATING',
    "content" JSONB,
    "sourceRefs" JSONB NOT NULL DEFAULT '{}',
    "model" TEXT,
    "promptSource" TEXT,
    "error" TEXT,
    "requestedById" TEXT,
    "executionTimeoutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publishing_topic_planning_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "publishing_topic_planning_analysis_topicId_version_key" ON "publishing_topic_planning_analysis"("topicId", "version");

-- CreateIndex
CREATE INDEX "publishing_topic_planning_analysis_topicId_createdAt_idx" ON "publishing_topic_planning_analysis"("topicId", "createdAt");

-- CreateIndex
CREATE INDEX "publishing_topic_planning_analysis_organizationId_idx" ON "publishing_topic_planning_analysis"("organizationId");

-- CreateIndex
CREATE INDEX "publishing_topic_planning_analysis_userId_idx" ON "publishing_topic_planning_analysis"("userId");

-- CreateIndex
CREATE INDEX "publishing_topic_planning_analysis_requestedById_idx" ON "publishing_topic_planning_analysis"("requestedById");

-- AddForeignKey
ALTER TABLE "publishing_topic_planning_analysis" ADD CONSTRAINT "publishing_topic_planning_analysis_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "publishing_topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_planning_analysis" ADD CONSTRAINT "publishing_topic_planning_analysis_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_planning_analysis" ADD CONSTRAINT "publishing_topic_planning_analysis_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_planning_analysis" ADD CONSTRAINT "publishing_topic_planning_analysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishing_topic_planning_analysis" ADD CONSTRAINT "publishing_topic_planning_analysis_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The three things Prisma cannot express.
-- ---------------------------------------------------------------------------

-- In-flight guard: at most ONE generating analysis per topic. The index is the
-- enforcement; the read in `startPlanningAnalysisAttempt` only turns the race
-- into a friendly "in flight" answer instead of a constraint error. Mirrors
-- `publishing_suggestion_cycle_active`.
CREATE UNIQUE INDEX "publishing_topic_planning_analysis_active"
    ON "publishing_topic_planning_analysis" ("topicId")
    WHERE "status" = 'GENERATING';

-- Strict tenant XOR, matching `publishing_topic_tenant_xor`. `<>` means EXACTLY
-- one of the two is non-null, so a row with neither is rejected as well. RLS is
-- not a substitute: its organization branch permits any `userId`, it does not
-- require null.
ALTER TABLE "publishing_topic_planning_analysis"
    ADD CONSTRAINT "publishing_topic_planning_analysis_tenant_xor"
    CHECK (("organizationId" IS NULL) <> ("userId" IS NULL));

-- A GENERATING row must carry its own liveness deadline, matching
-- `publishing_suggestion_cycle_generating_timeout`. Without it the partial
-- unique index above becomes a PERMANENT lock the moment a worker dies between
-- the insert and the terminal marker: the topic could never be analysed again
-- and no user action would recover it. Terminal rows may leave it NULL.
ALTER TABLE "publishing_topic_planning_analysis"
    ADD CONSTRAINT "publishing_topic_planning_analysis_generating_timeout"
    CHECK ("status" <> 'GENERATING' OR "executionTimeoutAt" IS NOT NULL);
