-- CreateEnum
CREATE TYPE "ProjectDocumentAnalysisKind" AS ENUM ('GENERATION', 'RERUN');

-- CreateEnum
CREATE TYPE "ProjectDocumentFindingResponseKind" AS ENUM ('CONFIRMED', 'RESPONDED');

-- AlterTable
ALTER TABLE "project_document_analysis" ADD COLUMN     "kind" "ProjectDocumentAnalysisKind" NOT NULL DEFAULT 'GENERATION',
ADD COLUMN     "proseHash" TEXT,
ADD COLUMN     "sourceManifest" JSONB,
ADD COLUMN     "sourceRunId" TEXT;

-- AlterTable
ALTER TABLE "project_document_finding" ADD COLUMN     "foldedTitles" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sectionHash" TEXT,
ADD COLUMN     "sectionKey" TEXT,
ADD COLUMN     "sourceRefs" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "stableKey" TEXT;

-- CreateTable
CREATE TABLE "project_document_finding_response" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "kind" "ProjectDocumentFindingResponseKind" NOT NULL,
    "text" TEXT,
    "findingTitle" TEXT NOT NULL,
    "answeredRunId" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "sectionHash" TEXT NOT NULL,
    "authorId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_document_finding_response_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_document_finding_response_projectId_idx" ON "project_document_finding_response"("projectId");

-- CreateIndex
CREATE INDEX "project_document_finding_response_organizationId_idx" ON "project_document_finding_response"("organizationId");

-- CreateIndex
CREATE INDEX "project_document_finding_response_authorId_idx" ON "project_document_finding_response"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "project_document_finding_response_documentId_stableKey_key" ON "project_document_finding_response"("documentId", "stableKey");

-- AddForeignKey
-- NOT VALID: the table already holds rows; the new column is NULL on all of
-- them, and 20261015150200 validates the constraint under a weaker lock. The
-- index on "sourceRunId" is built CONCURRENTLY in 20261015150100.
ALTER TABLE "project_document_analysis" ADD CONSTRAINT "project_document_analysis_sourceRunId_fkey" FOREIGN KEY ("sourceRunId") REFERENCES "project_document_analysis"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "project_document_finding_response" ADD CONSTRAINT "project_document_finding_response_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "project_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_finding_response" ADD CONSTRAINT "project_document_finding_response_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_finding_response" ADD CONSTRAINT "project_document_finding_response_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_finding_response" ADD CONSTRAINT "project_document_finding_response_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
