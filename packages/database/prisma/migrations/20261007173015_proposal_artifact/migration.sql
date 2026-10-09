-- CreateEnum
CREATE TYPE "ProjectDocumentAnalysisStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "ProjectDocumentFindingSeverity" AS ENUM ('BLOCKING', 'IMPORTANT', 'INFORMATIONAL');

-- CreateEnum
CREATE TYPE "ProjectDocumentFindingType" AS ENUM ('SCOPE', 'COMMERCIAL', 'ASSUMPTION', 'RISK', 'GAP', 'SOURCE_VALIDATION', 'ARCHITECTURE', 'BRANDING', 'OPPORTUNITY');

-- AlterTable
ALTER TABLE "project_document" ADD COLUMN     "liveAttempt" INTEGER,
ADD COLUMN     "liveContent" TEXT,
ADD COLUMN     "liveRunId" TEXT;

-- CreateTable
CREATE TABLE "project_document_analysis" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "runKey" TEXT NOT NULL,
    "status" "ProjectDocumentAnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "analyzedContent" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sourceContext" TEXT NOT NULL,
    "documentVersion" INTEGER,
    "contextCount" INTEGER NOT NULL DEFAULT 0,
    "promptVersionId" TEXT,
    "model" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_document_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_document_finding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "severity" "ProjectDocumentFindingSeverity" NOT NULL,
    "type" "ProjectDocumentFindingType" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "recommendation" TEXT,
    "sectionHeading" TEXT,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_document_finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_document_style" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "styleDirection" TEXT,
    "primaryColor" TEXT,
    "accentColors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_document_style_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_document_analysis_runKey_key" ON "project_document_analysis"("runKey");

-- CreateIndex
CREATE INDEX "project_document_analysis_documentId_createdAt_idx" ON "project_document_analysis"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "project_document_analysis_projectId_idx" ON "project_document_analysis"("projectId");

-- CreateIndex
CREATE INDEX "project_document_analysis_organizationId_idx" ON "project_document_analysis"("organizationId");

-- CreateIndex
CREATE INDEX "project_document_finding_analysisId_position_idx" ON "project_document_finding"("analysisId", "position");

-- CreateIndex
CREATE INDEX "project_document_finding_organizationId_idx" ON "project_document_finding"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "project_document_style_documentId_key" ON "project_document_style"("documentId");

-- CreateIndex
CREATE INDEX "project_document_style_projectId_idx" ON "project_document_style"("projectId");

-- CreateIndex
CREATE INDEX "project_document_style_organizationId_idx" ON "project_document_style"("organizationId");

-- CreateIndex
CREATE INDEX "project_document_style_updatedById_idx" ON "project_document_style"("updatedById");

-- AddForeignKey
ALTER TABLE "project_document_analysis" ADD CONSTRAINT "project_document_analysis_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "project_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_analysis" ADD CONSTRAINT "project_document_analysis_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_analysis" ADD CONSTRAINT "project_document_analysis_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_finding" ADD CONSTRAINT "project_document_finding_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "project_document_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_finding" ADD CONSTRAINT "project_document_finding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_style" ADD CONSTRAINT "project_document_style_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "project_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_style" ADD CONSTRAINT "project_document_style_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_style" ADD CONSTRAINT "project_document_style_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_style" ADD CONSTRAINT "project_document_style_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
