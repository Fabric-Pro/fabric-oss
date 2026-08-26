-- CreateEnum
CREATE TYPE "pending_pm_state_change_action" AS ENUM ('HIDE', 'UNHIDE', 'FLAG_MISSING');

-- CreateEnum
CREATE TYPE "pending_pm_state_change_status" AS ENUM ('PENDING', 'APPROVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "pm_state_change_entity_type" AS ENUM ('EPIC', 'FEATURE', 'STORY');

-- AlterTable
ALTER TABLE "project" ADD COLUMN "adoStatePollActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "lastAdoStatePollAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "epic" ADD COLUMN "draftingStage" "FeatureDraftingStage" NOT NULL DEFAULT 'PUBLISHED',
ADD COLUMN "draftingStageUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "feature" ADD COLUMN "draftingStage" "FeatureDraftingStage" NOT NULL DEFAULT 'PUBLISHED',
ADD COLUMN "draftingStageUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "pending_pm_state_change" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "entityType" "pm_state_change_entity_type" NOT NULL,
    "entityId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "previousState" TEXT NOT NULL,
    "newState" TEXT NOT NULL,
    "proposedAction" "pending_pm_state_change_action" NOT NULL,
    "status" "pending_pm_state_change_status" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,

    CONSTRAINT "pending_pm_state_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_pm_state_change_projectId_status_idx" ON "pending_pm_state_change"("projectId", "status");

-- CreateIndex
CREATE INDEX "pending_pm_state_change_entityId_idx" ON "pending_pm_state_change"("entityId");

-- Partial unique index: at most one PENDING entry per entity per project
CREATE UNIQUE INDEX "pending_pm_state_unique_active"
  ON "pending_pm_state_change" ("projectId", "entityType", "entityId")
  WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "pending_pm_state_change" ADD CONSTRAINT "pending_pm_state_change_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_pm_state_change" ADD CONSTRAINT "pending_pm_state_change_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
