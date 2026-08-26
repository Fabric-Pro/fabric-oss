-- CreateEnum
CREATE TYPE "CodeUnderstandingStatus" AS ENUM ('NOT_ANALYZED', 'PENDING', 'ANALYZING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "CodeUnderstandingGraphMode" AS ENUM ('TECHNICAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "CodeUnderstandingNodeKind" AS ENUM ('DIRECTORY', 'MODULE', 'FILE', 'CAPABILITY', 'DOMAIN');

-- CreateEnum
CREATE TYPE "CodeUnderstandingEdgeKind" AS ENUM ('CONTAINS', 'IMPORTS', 'DEPENDS_ON', 'COVERS', 'RELATES_TO');

-- CreateTable
CREATE TABLE "code_understanding_analysis" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryIntegrationId" TEXT,
    "provider" TEXT NOT NULL,
    "repositoryUrl" TEXT NOT NULL,
    "repositoryName" TEXT,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "status" "CodeUnderstandingStatus" NOT NULL DEFAULT 'NOT_ANALYZED',
    "analyzedCommitSha" TEXT,
    "analyzedCommitAt" TIMESTAMP(3),
    "analyzedAt" TIMESTAMP(3),
    "lastFullAnalysisAt" TIMESTAMP(3),
    "lastIncrementalAt" TIMESTAMP(3),
    "nodeCount" INTEGER NOT NULL DEFAULT 0,
    "edgeCount" INTEGER NOT NULL DEFAULT 0,
    "filesAnalyzed" INTEGER NOT NULL DEFAULT 0,
    "fileManifest" JSONB,
    "workflowId" TEXT,
    "error" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_understanding_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_understanding_node" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mode" "CodeUnderstandingGraphMode" NOT NULL,
    "kind" "CodeUnderstandingNodeKind" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "filePath" TEXT,
    "language" TEXT,
    "parentKey" TEXT,
    "technicalDescription" TEXT,
    "businessDescription" TEXT,
    "contentPreview" TEXT,
    "metrics" JSONB,
    "layout" JSONB,
    "contentHash" TEXT,
    "qdrantPointId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_understanding_node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_understanding_edge" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mode" "CodeUnderstandingGraphMode" NOT NULL,
    "kind" "CodeUnderstandingEdgeKind" NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "weight" INTEGER,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_understanding_edge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "code_understanding_analysis_projectId_idx" ON "code_understanding_analysis"("projectId");

-- CreateIndex
CREATE INDEX "code_understanding_analysis_userId_idx" ON "code_understanding_analysis"("userId");

-- CreateIndex
CREATE INDEX "code_understanding_analysis_organizationId_idx" ON "code_understanding_analysis"("organizationId");

-- CreateIndex
CREATE INDEX "code_understanding_analysis_status_idx" ON "code_understanding_analysis"("status");

-- CreateIndex
CREATE UNIQUE INDEX "code_understanding_analysis_projectId_repositoryIntegration_key" ON "code_understanding_analysis"("projectId", "repositoryIntegrationId");

-- CreateIndex
CREATE INDEX "code_understanding_node_analysisId_mode_idx" ON "code_understanding_node"("analysisId", "mode");

-- CreateIndex
CREATE INDEX "code_understanding_node_projectId_idx" ON "code_understanding_node"("projectId");

-- CreateIndex
CREATE INDEX "code_understanding_node_userId_idx" ON "code_understanding_node"("userId");

-- CreateIndex
CREATE INDEX "code_understanding_node_organizationId_idx" ON "code_understanding_node"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "code_understanding_node_analysisId_mode_key_key" ON "code_understanding_node"("analysisId", "mode", "key");

-- CreateIndex
CREATE INDEX "code_understanding_edge_analysisId_mode_idx" ON "code_understanding_edge"("analysisId", "mode");

-- CreateIndex
CREATE INDEX "code_understanding_edge_projectId_idx" ON "code_understanding_edge"("projectId");

-- CreateIndex
CREATE INDEX "code_understanding_edge_userId_idx" ON "code_understanding_edge"("userId");

-- CreateIndex
CREATE INDEX "code_understanding_edge_organizationId_idx" ON "code_understanding_edge"("organizationId");

-- AddForeignKey
ALTER TABLE "code_understanding_analysis" ADD CONSTRAINT "code_understanding_analysis_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_understanding_analysis" ADD CONSTRAINT "code_understanding_analysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_understanding_analysis" ADD CONSTRAINT "code_understanding_analysis_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_understanding_node" ADD CONSTRAINT "code_understanding_node_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "code_understanding_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_understanding_edge" ADD CONSTRAINT "code_understanding_edge_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "code_understanding_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
