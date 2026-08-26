-- AlterTable
ALTER TABLE "epic" ADD COLUMN     "lastPmSyncAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastPmSyncError" VARCHAR(500),
ADD COLUMN     "lastPmSyncStatus" "pm_sync_status",
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "lastSyncedPmHash" TEXT;

-- AlterTable
ALTER TABLE "feature" ADD COLUMN     "lastPmSyncAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastPmSyncError" VARCHAR(500),
ADD COLUMN     "lastPmSyncStatus" "pm_sync_status",
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "lastSyncedPmHash" TEXT;

-- CreateIndex
CREATE INDEX "epic_projectId_lastPmSyncStatus_idx" ON "epic"("projectId", "lastPmSyncStatus");

-- CreateIndex
CREATE INDEX "feature_projectId_lastPmSyncStatus_idx" ON "feature"("projectId", "lastPmSyncStatus");
