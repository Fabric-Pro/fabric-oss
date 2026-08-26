-- CreateEnum
CREATE TYPE "ScanCategory" AS ENUM ('SECURITY', 'ACCESSIBILITY');

-- CreateEnum
CREATE TYPE "ScanSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ScanTrigger" AS ENUM ('MANUAL', 'MATURATION_GATE');

-- CreateEnum
CREATE TYPE "ScanTargetType" AS ENUM ('PROJECT', 'FEATURE');

-- CreateEnum
CREATE TYPE "ScanFindingStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ScanEnforcementMode" AS ENUM ('WARN', 'BLOCK');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'SECURITY_SCAN_COMPLETED';

-- CreateTable
CREATE TABLE "project_scan_config" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "securityEnabled" BOOLEAN NOT NULL DEFAULT true,
    "accessibilityEnabled" BOOLEAN NOT NULL DEFAULT true,
    "enforcementMode" "ScanEnforcementMode" NOT NULL DEFAULT 'WARN',
    "autoScanOnMaturation" BOOLEAN NOT NULL DEFAULT true,
    "maturationGate" "FeatureDraftingStage" NOT NULL DEFAULT 'PUBLISHED',
    "customRules" JSONB,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_scan_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_scan" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "storyId" TEXT,
    "status" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "trigger" "ScanTrigger" NOT NULL DEFAULT 'MANUAL',
    "targetType" "ScanTargetType" NOT NULL DEFAULT 'PROJECT',
    "securityRequested" BOOLEAN NOT NULL DEFAULT true,
    "accessibilityRequested" BOOLEAN NOT NULL DEFAULT true,
    "securityFindingCount" INTEGER NOT NULL DEFAULT 0,
    "accessibilityFindingCount" INTEGER NOT NULL DEFAULT 0,
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

    CONSTRAINT "project_scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_finding" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "storyId" TEXT,
    "category" "ScanCategory" NOT NULL,
    "severity" "ScanSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "remediation" TEXT NOT NULL,
    "ruleSource" TEXT NOT NULL,
    "isCustomRule" BOOLEAN NOT NULL DEFAULT false,
    "location" TEXT,
    "status" "ScanFindingStatus" NOT NULL DEFAULT 'OPEN',
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scan_finding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_scan_config_projectId_key" ON "project_scan_config"("projectId");

-- CreateIndex
CREATE INDEX "project_scan_config_userId_idx" ON "project_scan_config"("userId");

-- CreateIndex
CREATE INDEX "project_scan_config_organizationId_idx" ON "project_scan_config"("organizationId");

-- CreateIndex
CREATE INDEX "project_scan_projectId_createdAt_idx" ON "project_scan"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "project_scan_storyId_idx" ON "project_scan"("storyId");

-- CreateIndex
CREATE INDEX "project_scan_userId_idx" ON "project_scan"("userId");

-- CreateIndex
CREATE INDEX "project_scan_organizationId_idx" ON "project_scan"("organizationId");

-- CreateIndex
CREATE INDEX "project_scan_status_idx" ON "project_scan"("status");

-- CreateIndex
CREATE INDEX "scan_finding_projectId_status_idx" ON "scan_finding"("projectId", "status");

-- CreateIndex
CREATE INDEX "scan_finding_scanId_idx" ON "scan_finding"("scanId");

-- CreateIndex
CREATE INDEX "scan_finding_storyId_idx" ON "scan_finding"("storyId");

-- CreateIndex
CREATE INDEX "scan_finding_userId_idx" ON "scan_finding"("userId");

-- CreateIndex
CREATE INDEX "scan_finding_organizationId_idx" ON "scan_finding"("organizationId");

-- CreateIndex
CREATE INDEX "scan_finding_category_severity_idx" ON "scan_finding"("category", "severity");

-- AddForeignKey
ALTER TABLE "project_scan_config" ADD CONSTRAINT "project_scan_config_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_scan_config" ADD CONSTRAINT "project_scan_config_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_scan_config" ADD CONSTRAINT "project_scan_config_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_scan" ADD CONSTRAINT "project_scan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_scan" ADD CONSTRAINT "project_scan_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_scan" ADD CONSTRAINT "project_scan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_scan" ADD CONSTRAINT "project_scan_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_finding" ADD CONSTRAINT "scan_finding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "project_scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_finding" ADD CONSTRAINT "scan_finding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_finding" ADD CONSTRAINT "scan_finding_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_finding" ADD CONSTRAINT "scan_finding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_finding" ADD CONSTRAINT "scan_finding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
