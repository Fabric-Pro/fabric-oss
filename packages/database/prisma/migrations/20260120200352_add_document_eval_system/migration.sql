-- CreateEnum
CREATE TYPE "GoldenReferenceScope" AS ENUM ('SYSTEM', 'USER', 'ORG');

-- AlterEnum (safe - only add if not exists)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'MICROSOFT_GRAPH' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'WorkflowIntegrationProvider')) THEN
        ALTER TYPE "WorkflowIntegrationProvider" ADD VALUE 'MICROSOFT_GRAPH';
    END IF;
END
$$;

-- DropIndex (safe - only if exists)
DROP INDEX IF EXISTS "public"."MCPConfig_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."MCPServer_organizationId_userId_isSystemProvided_idx";
DROP INDEX IF EXISTS "public"."agent_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."agent_workspace_file_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."ai_chat_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."ai_usage_log_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."project_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."project_projectManagementMcpServerId_idx";
DROP INDEX IF EXISTS "public"."purchase_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."wizard_temp_context_organizationId_userId_idx";

-- CreateTable
CREATE TABLE "golden_reference" (
    "id" TEXT NOT NULL,
    "documentType" "ProjectDocumentType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "content" TEXT NOT NULL,
    "projectContext" JSONB,
    "requiredSections" TEXT[],
    "keyPhrases" TEXT[],
    "qdrantPointId" TEXT,
    "qdrantCollection" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "scope" "GoldenReferenceScope" NOT NULL DEFAULT 'SYSTEM',
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "golden_reference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_eval" (
    "id" TEXT NOT NULL,
    "projectDocumentId" TEXT NOT NULL,
    "documentVersion" INTEGER NOT NULL,
    "goldenReferenceId" TEXT NOT NULL,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL DEFAULT 70,
    "structureScore" DOUBLE PRECISION NOT NULL,
    "coverageScore" DOUBLE PRECISION NOT NULL,
    "similarityScore" DOUBLE PRECISION NOT NULL,
    "qualityScore" DOUBLE PRECISION NOT NULL,
    "feedback" TEXT,
    "suggestions" TEXT[],
    "missingSections" TEXT[],
    "missingPhrases" TEXT[],
    "workflowId" TEXT,
    "executionTimeMs" INTEGER,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_eval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_eval_metric" (
    "id" TEXT NOT NULL,
    "documentEvalId" TEXT NOT NULL,
    "metricName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "rawValue" DOUBLE PRECISION,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_eval_metric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "golden_reference_documentType_idx" ON "golden_reference"("documentType");

-- CreateIndex
CREATE INDEX "golden_reference_scope_idx" ON "golden_reference"("scope");

-- CreateIndex
CREATE INDEX "golden_reference_isActive_idx" ON "golden_reference"("isActive");

-- CreateIndex
CREATE INDEX "golden_reference_userId_idx" ON "golden_reference"("userId");

-- CreateIndex
CREATE INDEX "golden_reference_organizationId_idx" ON "golden_reference"("organizationId");

-- CreateIndex
CREATE INDEX "document_eval_projectDocumentId_idx" ON "document_eval"("projectDocumentId");

-- CreateIndex
CREATE INDEX "document_eval_goldenReferenceId_idx" ON "document_eval"("goldenReferenceId");

-- CreateIndex
CREATE INDEX "document_eval_userId_idx" ON "document_eval"("userId");

-- CreateIndex
CREATE INDEX "document_eval_organizationId_idx" ON "document_eval"("organizationId");

-- CreateIndex
CREATE INDEX "document_eval_passed_idx" ON "document_eval"("passed");

-- CreateIndex
CREATE INDEX "document_eval_createdAt_idx" ON "document_eval"("createdAt");

-- CreateIndex
CREATE INDEX "document_eval_metric_documentEvalId_idx" ON "document_eval_metric"("documentEvalId");

-- CreateIndex
CREATE INDEX "document_eval_metric_metricName_idx" ON "document_eval_metric"("metricName");

-- CreateIndex
CREATE INDEX "document_eval_metric_category_idx" ON "document_eval_metric"("category");

-- AddForeignKey
ALTER TABLE "document_eval" ADD CONSTRAINT "document_eval_projectDocumentId_fkey" FOREIGN KEY ("projectDocumentId") REFERENCES "project_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_eval" ADD CONSTRAINT "document_eval_goldenReferenceId_fkey" FOREIGN KEY ("goldenReferenceId") REFERENCES "golden_reference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_eval_metric" ADD CONSTRAINT "document_eval_metric_documentEvalId_fkey" FOREIGN KEY ("documentEvalId") REFERENCES "document_eval"("id") ON DELETE CASCADE ON UPDATE CASCADE;
