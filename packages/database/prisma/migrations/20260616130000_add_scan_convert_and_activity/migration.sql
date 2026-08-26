-- AlterEnum: new story source so converted findings are filterable by Source.
ALTER TYPE "StorySource" ADD VALUE 'SECURITY_SCAN';

-- CreateEnum
CREATE TYPE "ScanActivityType" AS ENUM ('SCAN_STARTED', 'SCAN_COMPLETED', 'SCAN_FAILED', 'FINDING_RESOLVED', 'FINDING_DISMISSED', 'FINDING_REOPENED', 'FINDING_CONVERTED', 'CONFIG_UPDATED');

-- AlterTable: link a finding to the work item it was converted into.
ALTER TABLE "scan_finding" ADD COLUMN     "convertedStoryId" TEXT,
ADD COLUMN     "convertedStoryIdentifier" TEXT,
ADD COLUMN     "convertedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "scan_activity" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "ScanActivityType" NOT NULL,
    "scanId" TEXT,
    "findingId" TEXT,
    "storyId" TEXT,
    "summary" TEXT,
    "metadata" JSONB,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scan_finding_convertedStoryId_idx" ON "scan_finding"("convertedStoryId");

-- CreateIndex
CREATE INDEX "scan_activity_projectId_createdAt_idx" ON "scan_activity"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "scan_activity_userId_idx" ON "scan_activity"("userId");

-- CreateIndex
CREATE INDEX "scan_activity_organizationId_idx" ON "scan_activity"("organizationId");

-- AddForeignKey
ALTER TABLE "scan_activity" ADD CONSTRAINT "scan_activity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_activity" ADD CONSTRAINT "scan_activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_activity" ADD CONSTRAINT "scan_activity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
