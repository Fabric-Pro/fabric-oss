-- Per-project QA policy (Settings ▸ Testing) + the deployment targets it and
-- the QA run config both reference (Settings ▸ Environments).

-- CreateEnum
CREATE TYPE "QaStrategyDepth" AS ENUM ('EASY', 'AVERAGE', 'HARD');

-- CreateEnum
CREATE TYPE "QaEvidencePolicy" AS ENUM ('SCREENSHOT_REQUIRED', 'OPTIONAL', 'NONE');

-- CreateEnum
CREATE TYPE "ProjectEnvironmentType" AS ENUM ('STAGING', 'QA', 'PRODUCTION');

-- CreateTable
CREATE TABLE "project_qa_settings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "strategyDepth" "QaStrategyDepth" NOT NULL DEFAULT 'AVERAGE',
    "confidenceThreshold" INTEGER NOT NULL DEFAULT 80,
    "indexCoverageEnabled" BOOLEAN NOT NULL DEFAULT true,
    "coverageTarget" INTEGER NOT NULL DEFAULT 80,
    "resolutions" TEXT[] DEFAULT ARRAY['1920x1080', '1366x768']::TEXT[],
    "browsers" TEXT[] DEFAULT ARRAY['chromium']::TEXT[],
    "rulesMarkdown" TEXT,
    "implementationNotes" TEXT,
    "evidencePolicy" "QaEvidencePolicy" NOT NULL DEFAULT 'SCREENSHOT_REQUIRED',
    "scepticRolesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "scepticRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "defaultEnvironmentId" TEXT,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_qa_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_environment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "ProjectEnvironmentType" NOT NULL DEFAULT 'STAGING',
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_environment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_qa_settings_projectId_key" ON "project_qa_settings"("projectId");

-- CreateIndex
CREATE INDEX "project_qa_settings_userId_idx" ON "project_qa_settings"("userId");

-- CreateIndex
CREATE INDEX "project_qa_settings_organizationId_idx" ON "project_qa_settings"("organizationId");

-- CreateIndex
CREATE INDEX "project_environment_projectId_idx" ON "project_environment"("projectId");

-- CreateIndex
CREATE INDEX "project_environment_userId_idx" ON "project_environment"("userId");

-- CreateIndex
CREATE INDEX "project_environment_organizationId_idx" ON "project_environment"("organizationId");

-- AddForeignKey
ALTER TABLE "project_qa_settings" ADD CONSTRAINT "project_qa_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_qa_settings" ADD CONSTRAINT "project_qa_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_qa_settings" ADD CONSTRAINT "project_qa_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_environment" ADD CONSTRAINT "project_environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_environment" ADD CONSTRAINT "project_environment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_environment" ADD CONSTRAINT "project_environment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
