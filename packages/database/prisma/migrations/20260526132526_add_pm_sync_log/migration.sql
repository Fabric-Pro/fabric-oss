-- CreateEnum
CREATE TYPE "pm_sync_log_status" AS ENUM ('SUCCESS', 'FAILURE', 'CONFLICT');

-- CreateTable
CREATE TABLE "pm_sync_log" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "direction" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "pmTool" TEXT NOT NULL,
    "status" "pm_sync_log_status" NOT NULL,
    "errorPayload" JSONB,
    "batchId" TEXT,
    "actorUserId" TEXT,
    "correlationId" TEXT,
    "durationMs" INTEGER,
    "externalId" TEXT,
    "externalUrl" TEXT,
    "organizationId" TEXT,
    "userId" TEXT,
    "projectId" TEXT,

    CONSTRAINT "pm_sync_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pm_sync_log_projectId_createdAt_idx" ON "pm_sync_log"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "pm_sync_log_entityId_createdAt_idx" ON "pm_sync_log"("entityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "pm_sync_log_batchId_idx" ON "pm_sync_log"("batchId");

-- CreateIndex
CREATE INDEX "pm_sync_log_status_createdAt_idx" ON "pm_sync_log"("status", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "pm_sync_log" ADD CONSTRAINT "pm_sync_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pm_sync_log" ADD CONSTRAINT "pm_sync_log_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pm_sync_log" ADD CONSTRAINT "pm_sync_log_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
