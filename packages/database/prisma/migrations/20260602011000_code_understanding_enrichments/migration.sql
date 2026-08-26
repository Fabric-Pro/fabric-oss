-- CreateEnum
CREATE TYPE "CodeUnderstandingRunStatus" AS ENUM ('RUNNING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "CodeUnderstandingChatVisibility" AS ENUM ('PRIVATE', 'SHARED');

-- AlterTable
ALTER TABLE "code_understanding_analysis" ADD COLUMN     "businessTour" JSONB,
ADD COLUMN     "techStack" JSONB;

-- AlterTable
ALTER TABLE "code_understanding_node" ADD COLUMN     "documentation" TEXT;

-- CreateTable
CREATE TABLE "code_understanding_analysis_run" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "triggeredByUserId" TEXT,
    "mode" TEXT NOT NULL,
    "status" "CodeUnderstandingRunStatus" NOT NULL DEFAULT 'RUNNING',
    "commitSha" TEXT,
    "commitAt" TIMESTAMP(3),
    "nodeCount" INTEGER NOT NULL DEFAULT 0,
    "edgeCount" INTEGER NOT NULL DEFAULT 0,
    "filesAnalyzed" INTEGER NOT NULL DEFAULT 0,
    "modulesDescribed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,

    CONSTRAINT "code_understanding_analysis_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_understanding_conversation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryIntegrationId" TEXT,
    "mode" "CodeUnderstandingGraphMode" NOT NULL DEFAULT 'BUSINESS',
    "title" TEXT NOT NULL DEFAULT 'New conversation',
    "visibility" "CodeUnderstandingChatVisibility" NOT NULL DEFAULT 'PRIVATE',
    "messages" JSONB NOT NULL DEFAULT '[]',
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_understanding_conversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "code_understanding_analysis_run_analysisId_startedAt_idx" ON "code_understanding_analysis_run"("analysisId", "startedAt");

-- CreateIndex
CREATE INDEX "code_understanding_analysis_run_projectId_idx" ON "code_understanding_analysis_run"("projectId");

-- CreateIndex
CREATE INDEX "code_understanding_analysis_run_userId_idx" ON "code_understanding_analysis_run"("userId");

-- CreateIndex
CREATE INDEX "code_understanding_analysis_run_organizationId_idx" ON "code_understanding_analysis_run"("organizationId");

-- CreateIndex
CREATE INDEX "code_understanding_conversation_projectId_repositoryIntegra_idx" ON "code_understanding_conversation"("projectId", "repositoryIntegrationId", "mode");

-- CreateIndex
CREATE INDEX "code_understanding_conversation_userId_idx" ON "code_understanding_conversation"("userId");

-- CreateIndex
CREATE INDEX "code_understanding_conversation_organizationId_idx" ON "code_understanding_conversation"("organizationId");

-- AddForeignKey
ALTER TABLE "code_understanding_analysis_run" ADD CONSTRAINT "code_understanding_analysis_run_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "code_understanding_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_understanding_conversation" ADD CONSTRAINT "code_understanding_conversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
