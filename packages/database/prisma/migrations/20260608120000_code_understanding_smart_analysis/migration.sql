-- Atlas "smart analysis" foundation: per-node AI category, stable user
-- overrides (description/category) that survive re-analysis + their edit
-- history, analysis/run AI telemetry (model, tokens, cost in micro-USD,
-- duration), non-blocking re-analysis markers (activeRunStatus/StartedAt +
-- appliedUserOverrides), and per project+repo branch pinning.

-- AlterTable
ALTER TABLE "code_understanding_analysis" ADD COLUMN     "activeRunStartedAt" TIMESTAMP(3),
ADD COLUMN     "activeRunStatus" "CodeUnderstandingStatus",
ADD COLUMN     "analysisDurationMs" INTEGER,
ADD COLUMN     "analysisModel" TEXT,
ADD COLUMN     "appliedUserOverrides" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "completionTokens" INTEGER,
ADD COLUMN     "costMicroUsd" INTEGER,
ADD COLUMN     "promptTokens" INTEGER,
ADD COLUMN     "reasoning" TEXT,
ADD COLUMN     "totalTokens" INTEGER;

-- AlterTable
ALTER TABLE "code_understanding_node" ADD COLUMN     "category" TEXT;

-- AlterTable
ALTER TABLE "code_understanding_analysis_run" ADD COLUMN     "branch" TEXT,
ADD COLUMN     "completionTokens" INTEGER,
ADD COLUMN     "costMicroUsd" INTEGER,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "promptTokens" INTEGER,
ADD COLUMN     "totalTokens" INTEGER;

-- AlterTable
ALTER TABLE "project_repository_integration" ADD COLUMN     "pinnedBranches" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "code_understanding_node_override" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryIntegrationId" TEXT,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "mode" "CodeUnderstandingGraphMode" NOT NULL,
    "key" TEXT NOT NULL,
    "userDescription" TEXT,
    "userCategory" TEXT,
    "updatedByUserId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_understanding_node_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_understanding_node_override_history" (
    "id" TEXT NOT NULL,
    "overrideId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "editedByUserId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_understanding_node_override_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "code_understanding_node_override_projectId_idx" ON "code_understanding_node_override"("projectId");

-- CreateIndex
CREATE INDEX "code_understanding_node_override_projectId_repositoryIntegr_idx" ON "code_understanding_node_override"("projectId", "repositoryIntegrationId", "branch", "mode");

-- CreateIndex
CREATE INDEX "code_understanding_node_override_userId_idx" ON "code_understanding_node_override"("userId");

-- CreateIndex
CREATE INDEX "code_understanding_node_override_organizationId_idx" ON "code_understanding_node_override"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "code_understanding_node_override_projectId_repositoryIntegr_key" ON "code_understanding_node_override"("projectId", "repositoryIntegrationId", "branch", "mode", "key");

-- CreateIndex
CREATE INDEX "code_understanding_node_override_history_overrideId_created_idx" ON "code_understanding_node_override_history"("overrideId", "createdAt");

-- CreateIndex
CREATE INDEX "code_understanding_node_override_history_userId_idx" ON "code_understanding_node_override_history"("userId");

-- CreateIndex
CREATE INDEX "code_understanding_node_override_history_organizationId_idx" ON "code_understanding_node_override_history"("organizationId");

-- AddForeignKey
ALTER TABLE "code_understanding_node_override" ADD CONSTRAINT "code_understanding_node_override_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_understanding_node_override_history" ADD CONSTRAINT "code_understanding_node_override_history_overrideId_fkey" FOREIGN KEY ("overrideId") REFERENCES "code_understanding_node_override"("id") ON DELETE CASCADE ON UPDATE CASCADE;

