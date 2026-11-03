-- CreateEnum
CREATE TYPE "InstructionConsolidationStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "instruction_consolidation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "InstructionConsolidationStatus" NOT NULL DEFAULT 'RUNNING',
    "step" TEXT NOT NULL DEFAULT 'CREATED',
    "sourceIntegrationId" TEXT NOT NULL,
    "targetIntegrationId" TEXT,
    "targetRepositoryUrl" TEXT,
    "sourceCommitSha" TEXT,
    "copiedCommitSha" TEXT,
    "cleanupPullRequestUrl" TEXT,
    "files" JSONB NOT NULL,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instruction_consolidation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instruction_consolidation_projectId_createdAt_idx" ON "instruction_consolidation"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "instruction_consolidation_userId_idx" ON "instruction_consolidation"("userId");

-- CreateIndex
CREATE INDEX "instruction_consolidation_organizationId_idx" ON "instruction_consolidation"("organizationId");

-- AddForeignKey
ALTER TABLE "instruction_consolidation" ADD CONSTRAINT "instruction_consolidation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
