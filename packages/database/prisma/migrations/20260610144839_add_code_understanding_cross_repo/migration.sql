-- CreateEnum
CREATE TYPE "CodeUnderstandingCrossEdgeKind" AS ENUM ('SHARES_LIBRARY', 'DEPENDS_ON', 'CALLS_API', 'RELATES_TO');

-- CreateEnum
CREATE TYPE "CodeUnderstandingCrossEdgeDetection" AS ENUM ('STRUCTURAL', 'AI');

-- CreateEnum
CREATE TYPE "CodeUnderstandingCrossLinkStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "code_understanding_conversation" ADD COLUMN     "isSystemScope" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "code_understanding_cross_edge" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mode" "CodeUnderstandingGraphMode" NOT NULL,
    "kind" "CodeUnderstandingCrossEdgeKind" NOT NULL,
    "detection" "CodeUnderstandingCrossEdgeDetection" NOT NULL,
    "sourceAnalysisId" TEXT NOT NULL,
    "sourceKey" TEXT,
    "targetAnalysisId" TEXT NOT NULL,
    "targetKey" TEXT,
    "weight" INTEGER,
    "description" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_understanding_cross_edge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_understanding_cross_link" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "CodeUnderstandingCrossLinkStatus" NOT NULL DEFAULT 'PENDING',
    "signature" TEXT,
    "repositoryIntegrationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "edgeCount" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "totalTokens" INTEGER,
    "costMicroUsd" INTEGER,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_understanding_cross_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "code_understanding_cross_edge_projectId_mode_idx" ON "code_understanding_cross_edge"("projectId", "mode");

-- CreateIndex
CREATE INDEX "code_understanding_cross_edge_sourceAnalysisId_idx" ON "code_understanding_cross_edge"("sourceAnalysisId");

-- CreateIndex
CREATE INDEX "code_understanding_cross_edge_targetAnalysisId_idx" ON "code_understanding_cross_edge"("targetAnalysisId");

-- CreateIndex
CREATE INDEX "code_understanding_cross_edge_userId_idx" ON "code_understanding_cross_edge"("userId");

-- CreateIndex
CREATE INDEX "code_understanding_cross_edge_organizationId_idx" ON "code_understanding_cross_edge"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "code_understanding_cross_edge_projectId_mode_kind_sourceAna_key" ON "code_understanding_cross_edge"("projectId", "mode", "kind", "sourceAnalysisId", "sourceKey", "targetAnalysisId", "targetKey");

-- CreateIndex
CREATE UNIQUE INDEX "code_understanding_cross_link_projectId_key" ON "code_understanding_cross_link"("projectId");

-- CreateIndex
CREATE INDEX "code_understanding_cross_link_userId_idx" ON "code_understanding_cross_link"("userId");

-- CreateIndex
CREATE INDEX "code_understanding_cross_link_organizationId_idx" ON "code_understanding_cross_link"("organizationId");

-- AddForeignKey
ALTER TABLE "code_understanding_cross_edge" ADD CONSTRAINT "code_understanding_cross_edge_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_understanding_cross_link" ADD CONSTRAINT "code_understanding_cross_link_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

