-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ScanActivityType" ADD VALUE 'FINDINGS_PURGED';
ALTER TYPE "ScanActivityType" ADD VALUE 'FINDINGS_REVIEWED';

-- AlterTable
ALTER TABLE "project_scan_config" ADD COLUMN     "securityKnowledgePacks" JSONB,
ADD COLUMN     "severityRubric" JSONB;

-- AlterTable
ALTER TABLE "scan_finding" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "firstDetectedAt" TIMESTAMP(3),
ADD COLUMN     "fingerprint" TEXT;

-- CreateTable
CREATE TABLE "scan_finding_review" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "proposals" JSONB,
    "reviewedCount" INTEGER NOT NULL DEFAULT 0,
    "modelName" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "durationMs" INTEGER,
    "error" TEXT,
    "workflowId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scan_finding_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scan_finding_review_projectId_createdAt_idx" ON "scan_finding_review"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "scan_finding_review_userId_idx" ON "scan_finding_review"("userId");

-- CreateIndex
CREATE INDEX "scan_finding_review_organizationId_idx" ON "scan_finding_review"("organizationId");

-- CreateIndex
CREATE INDEX "scan_finding_projectId_fingerprint_idx" ON "scan_finding"("projectId", "fingerprint");

-- AddForeignKey
ALTER TABLE "scan_finding_review" ADD CONSTRAINT "scan_finding_review_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_finding_review" ADD CONSTRAINT "scan_finding_review_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_finding_review" ADD CONSTRAINT "scan_finding_review_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
