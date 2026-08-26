-- CreateEnum
CREATE TYPE "StatusUpdateLifecycle" AS ENUM ('INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "StatusUpdateImpact" AS ENUM ('NONE', 'MINOR', 'MAJOR', 'CRITICAL');

-- CreateTable
CREATE TABLE "status_update" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "lifecycle" "StatusUpdateLifecycle" NOT NULL DEFAULT 'INVESTIGATING',
    "impact" "StatusUpdateImpact" NOT NULL,
    "affectedComponentKeys" TEXT[],
    "affectedProviderKeys" TEXT[],
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "scheduledFor" TIMESTAMP(3),
    "componentIncidentId" TEXT,
    "integrationIncidentId" TEXT,
    "publishedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "status_update_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_update_revision" (
    "id" TEXT NOT NULL,
    "statusUpdateId" TEXT NOT NULL,
    "lifecycle" "StatusUpdateLifecycle" NOT NULL,
    "body" TEXT NOT NULL,
    "authorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_update_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "status_update_lifecycle_startedAt_idx" ON "status_update"("lifecycle", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "status_update_startedAt_idx" ON "status_update"("startedAt" DESC);

-- CreateIndex
CREATE INDEX "status_update_scheduledFor_idx" ON "status_update"("scheduledFor");

-- CreateIndex
CREATE INDEX "status_update_revision_statusUpdateId_createdAt_idx" ON "status_update_revision"("statusUpdateId", "createdAt");

-- AddForeignKey
ALTER TABLE "status_update" ADD CONSTRAINT "status_update_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_update_revision" ADD CONSTRAINT "status_update_revision_statusUpdateId_fkey" FOREIGN KEY ("statusUpdateId") REFERENCES "status_update"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_update_revision" ADD CONSTRAINT "status_update_revision_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

