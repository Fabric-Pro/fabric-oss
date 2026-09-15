-- Inverted loop: engagement profiles, delivery tracks, governed stage approvals, scope-intake provenance.
-- Plan: docs/features/inverted-loop-delivery-tracks.md (Sprint 1 + 2 schema).

-- CreateEnum
CREATE TYPE "EngagementProfile" AS ENUM ('EXPLORE', 'PROPOSAL', 'GOVERNED', 'DELEGATED');

-- CreateEnum
CREATE TYPE "DeliveryTrack" AS ENUM ('UNCLASSIFIED', 'SPIKE', 'DISCOVERY', 'SPECIFY', 'DEFER');

-- CreateEnum
CREATE TYPE "TrackSetBy" AS ENUM ('AI', 'HUMAN');

-- CreateEnum
CREATE TYPE "StageTransitionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- AlterEnum
ALTER TYPE "PendingBacklogProposalSource" ADD VALUE 'SCOPE_DOCUMENT';

-- AlterEnum
ALTER TYPE "PendingBacklogProposalStatus" ADD VALUE 'APPLYING';

-- AlterEnum
ALTER TYPE "StorySource" ADD VALUE 'IMPORTED_SCOPE';

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "documentTiersAdvisory" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enforceDiscoveryGate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enforceSpecifyGate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enforceSpikeGate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "engagementProfile" "EngagementProfile" NOT NULL DEFAULT 'GOVERNED',
ADD COLUMN     "engagementProfileUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "quotedPhases" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "visionCoreActions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "visionCycle" TEXT,
ADD COLUMN     "visionPurpose" TEXT;

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "deliveryTrack" "DeliveryTrack" NOT NULL DEFAULT 'UNCLASSIFIED',
ADD COLUMN     "dependsOnPhases" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "dependsOnRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sourceDependencyRaw" TEXT,
ADD COLUMN     "sourceRef" TEXT,
ADD COLUMN     "trackRationale" TEXT,
ADD COLUMN     "trackSetBy" "TrackSetBy",
ADD COLUMN     "trackUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "weave_execution" ADD COLUMN     "userStoryId" TEXT;

-- CreateTable
CREATE TABLE "pending_backlog_proposal_application" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "changeIndex" INTEGER NOT NULL,
    "createdEntityType" TEXT,
    "createdEntityId" TEXT,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_backlog_proposal_application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_stage_approver" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_stage_approver_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateTable
CREATE TABLE "stage_transition_request" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "fromStage" "FeatureDraftingStage" NOT NULL,
    "toStage" "FeatureDraftingStage" NOT NULL,
    "patch" JSONB,
    "reason" TEXT NOT NULL,
    "status" "StageTransitionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stage_transition_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_backlog_proposal_application_proposalId_idx" ON "pending_backlog_proposal_application"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "pending_backlog_proposal_application_proposalId_changeIndex_key" ON "pending_backlog_proposal_application"("proposalId", "changeIndex");

-- CreateIndex
CREATE INDEX "project_stage_approver_userId_idx" ON "project_stage_approver"("userId");

-- CreateIndex
CREATE INDEX "stage_transition_request_projectId_status_idx" ON "stage_transition_request"("projectId", "status");

-- CreateIndex
CREATE INDEX "stage_transition_request_storyId_idx" ON "stage_transition_request"("storyId");

-- CreateIndex
CREATE INDEX "stage_transition_request_userId_idx" ON "stage_transition_request"("userId");

-- CreateIndex
CREATE INDEX "stage_transition_request_organizationId_idx" ON "stage_transition_request"("organizationId");


-- AddForeignKey
ALTER TABLE "pending_backlog_proposal_application" ADD CONSTRAINT "pending_backlog_proposal_application_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "pending_backlog_proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_stage_approver" ADD CONSTRAINT "project_stage_approver_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_stage_approver" ADD CONSTRAINT "project_stage_approver_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_transition_request" ADD CONSTRAINT "stage_transition_request_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_transition_request" ADD CONSTRAINT "stage_transition_request_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_transition_request" ADD CONSTRAINT "stage_transition_request_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_transition_request" ADD CONSTRAINT "stage_transition_request_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_transition_request" ADD CONSTRAINT "stage_transition_request_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Partial unique indexes (Prisma has no native partial unique; identifiers are
-- Prisma's camelCase column names, quoted). Precedent:
-- 20260505120000_add_ado_state_polling/migration.sql
-- ---------------------------------------------------------------------------

-- migration-lint: allow blocking-index — the three builds below are PARTIAL UNIQUE
-- indexes. CREATE UNIQUE INDEX CONCURRENTLY cannot run inside Prisma's migration
-- transaction, and a concurrent unique build that meets a duplicate leaves an
-- INVALID index behind that silently enforces nothing (precedent:
-- 20260816140000_add_two_factor_step_up_grant). The builds are short by
-- construction: "coding_run"/"weave_execution" match only rows in an active
-- status (a handful per project), and "user_story"."sourceRef" is a column this
-- migration just added, so its predicate matches zero rows at deploy time. The
-- plain (non-unique) indexes on populated tables live in the following
-- single-statement CONCURRENTLY migrations (20260914140001..3).

-- F2: at most one active coding run per story (closes the check-then-create race in start-coding-run)
CREATE UNIQUE INDEX "coding_run_one_active_per_story"
  ON "coding_run" ("storyId")
  WHERE "status" IN ('QUEUED','STARTING','RUNNING','AWAITING_REVIEW','PR_OPENED');

-- F2: at most one active Weave execution per story (userStoryId denormalized from weave_plan)
CREATE UNIQUE INDEX "weave_execution_one_active_per_story"
  ON "weave_execution" ("userStoryId")
  WHERE "userStoryId" IS NOT NULL AND "status" IN ('PENDING','RUNNING','PAUSED','CHECKPOINT');

-- F3: a retried scope import cannot create a second story for the same customer line ID
CREATE UNIQUE INDEX "user_story_project_source_ref_uq"
  ON "user_story" ("projectId", "sourceRef")
  WHERE "sourceRef" IS NOT NULL;

-- Slice 5: at most one PENDING stage transition request per story
CREATE UNIQUE INDEX "stage_transition_request_one_pending_per_story"
  ON "stage_transition_request" ("storyId")
  WHERE "status" = 'PENDING';

-- Backfill denormalized userStoryId on existing weave executions
UPDATE "weave_execution" e
SET "userStoryId" = p."userStoryId"
FROM "weave_plan" p
WHERE e."planId" = p."id" AND e."userStoryId" IS NULL AND p."userStoryId" IS NOT NULL;
