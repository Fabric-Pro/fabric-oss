-- Inverted loop, Sprint 3-6: spike runs, project-scoped frames, discovery runs and
-- integration contracts, estimate confidence, success metrics, outcomes token.
-- Plan: docs/features/inverted-loop-delivery-tracks.md (Slices 3, 4, 7, 8).

-- CreateEnum
CREATE TYPE "EstimateConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "DiscoveryRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'CONTRACT_READY', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MetricDirection" AS ENUM ('UP', 'DOWN');

-- CreateEnum
CREATE TYPE "MetricSourceKind" AS ENUM ('MANUAL', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "CodingRunKind" AS ENUM ('IMPLEMENT', 'SPIKE');

-- AlterEnum
ALTER TYPE "CodingRunStatus" ADD VALUE 'DEMO_READY';

-- AlterEnum
ALTER TYPE "FrameShareScope" ADD VALUE 'PROJECT';

-- AlterEnum
ALTER TYPE "ProjectDocumentType" ADD VALUE 'INTEGRATION_CONTRACT';

-- AlterTable
ALTER TABLE "agent_workspace_file" ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "storyId" TEXT;

-- AlterTable
ALTER TABLE "coding_run" ADD COLUMN     "demoFrameId" TEXT,
ADD COLUMN     "demoUrl" TEXT,
ADD COLUMN     "findings" TEXT,
ADD COLUMN     "kind" "CodingRunKind" NOT NULL DEFAULT 'IMPLEMENT',
ADD COLUMN     "mergedAt" TIMESTAMP(3),
ADD COLUMN     "playNotes" TEXT,
ADD COLUMN     "spikeBranch" TEXT,
ADD COLUMN     "spikeQuestion" TEXT;

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "outcomesShareToken" TEXT;

-- AlterTable
ALTER TABLE "project_document" ADD COLUMN     "storyId" TEXT;

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "estimateConfidence" "EstimateConfidence";

-- CreateTable
CREATE TABLE "discovery_run" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "status" "DiscoveryRunStatus" NOT NULL DEFAULT 'QUEUED',
    "sources" JSONB NOT NULL,
    "documentId" TEXT,
    "workflowId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discovery_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_success_metric" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "direction" "MetricDirection" NOT NULL DEFAULT 'UP',
    "target" DOUBLE PRECISION,
    "sourceKind" "MetricSourceKind" NOT NULL DEFAULT 'MANUAL',
    "webhookSecretHash" TEXT,
    "lastValue" DOUBLE PRECISION,
    "previousValue" DOUBLE PRECISION,
    "lastObservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_success_metric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "discovery_run_projectId_idx" ON "discovery_run"("projectId");

-- CreateIndex
CREATE INDEX "discovery_run_storyId_idx" ON "discovery_run"("storyId");

-- CreateIndex
CREATE INDEX "discovery_run_userId_idx" ON "discovery_run"("userId");

-- CreateIndex
CREATE INDEX "discovery_run_organizationId_idx" ON "discovery_run"("organizationId");

-- CreateIndex
CREATE INDEX "discovery_run_status_idx" ON "discovery_run"("status");

-- CreateIndex
CREATE INDEX "project_success_metric_projectId_idx" ON "project_success_metric"("projectId");

-- CreateIndex
CREATE INDEX "project_success_metric_userId_idx" ON "project_success_metric"("userId");

-- CreateIndex
CREATE INDEX "project_success_metric_organizationId_idx" ON "project_success_metric"("organizationId");


-- CreateIndex
-- migration-lint: allow blocking-index — UNIQUE index on a column this migration
-- just added to "project" (a small table; every row NULL at deploy, and
-- "discovery_run_one_active_per_story" below is a partial unique on a table this
-- migration creates). A concurrent unique build cannot run inside Prisma's
-- migration transaction and would leave an INVALID index on a duplicate
-- (precedent: 20260816140000). The plain indexes on populated tables live in the
-- single-statement CONCURRENTLY migrations 20260914210002..5.
CREATE UNIQUE INDEX "project_outcomesShareToken_key" ON "project"("outcomesShareToken");

-- AddForeignKey
ALTER TABLE "discovery_run" ADD CONSTRAINT "discovery_run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_run" ADD CONSTRAINT "discovery_run_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_run" ADD CONSTRAINT "discovery_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_run" ADD CONSTRAINT "discovery_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_success_metric" ADD CONSTRAINT "project_success_metric_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_success_metric" ADD CONSTRAINT "project_success_metric_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_success_metric" ADD CONSTRAINT "project_success_metric_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Partial unique indexes (quoted camelCase identifiers; see
-- 20260914140000_inverted_loop_profiles_tracks_governance for precedent).
-- ---------------------------------------------------------------------------

-- One active discovery run per story.
CREATE UNIQUE INDEX "discovery_run_one_active_per_story"
  ON "discovery_run" ("storyId")
  WHERE "status" IN ('QUEUED','RUNNING','CONTRACT_READY');
