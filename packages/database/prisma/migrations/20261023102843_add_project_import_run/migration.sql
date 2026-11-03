-- CreateEnum
CREATE TYPE "ProjectImportRunStatus" AS ENUM ('RUNNING', 'REVIEW', 'APPLYING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "project_import_run" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "ProjectImportRunStatus" NOT NULL DEFAULT 'RUNNING',
    "repositoryIntegrationId" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "findings" JSONB,
    "error" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_import_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_import_run_projectId_createdAt_idx" ON "project_import_run"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "project_import_run_userId_idx" ON "project_import_run"("userId");

-- CreateIndex
CREATE INDEX "project_import_run_organizationId_idx" ON "project_import_run"("organizationId");

-- AddForeignKey
ALTER TABLE "project_import_run" ADD CONSTRAINT "project_import_run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
