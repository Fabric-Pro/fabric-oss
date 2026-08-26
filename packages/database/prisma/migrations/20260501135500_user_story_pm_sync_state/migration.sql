-- CreateEnum
CREATE TYPE "pm_sync_status" AS ENUM ('PENDING', 'SUCCESS', 'CONFLICT', 'FAILED');

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "lastPmSyncAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastPmSyncError" VARCHAR(500),
ADD COLUMN     "lastPmSyncStatus" "pm_sync_status",
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "lastSyncedPmHash" TEXT;

-- CreateIndex
CREATE INDEX "user_story_projectId_lastPmSyncStatus_idx" ON "user_story"("projectId", "lastPmSyncStatus");
