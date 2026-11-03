-- Content-type chunking (additive). Every existing row keeps today's chunking:
-- the toggles default to off and the per-source columns are null.

-- CreateEnum
CREATE TYPE "ProjectChunkingRunKind" AS ENUM ('RECHUNK', 'MEASURE', 'TUNE');

-- CreateEnum
CREATE TYPE "ProjectChunkingRunStatus" AS ENUM ('RUNNING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'SUPERSEDED', 'CANCELLED');

-- AlterTable
ALTER TABLE "organization_rag_settings" ADD COLUMN     "chunkByContentType" BOOLEAN,
ADD COLUMN     "chunkProfiles" JSONB,
ADD COLUMN     "chunkingVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "project_document" ADD COLUMN     "chunkProfile" TEXT,
ADD COLUMN     "chunkingVersion" INTEGER;

-- AlterTable
ALTER TABLE "project_context" ADD COLUMN     "chunkProfile" TEXT,
ADD COLUMN     "chunkingVersion" INTEGER;

-- AlterTable
ALTER TABLE "company_context_source" ADD COLUMN     "chunkProfile" TEXT,
ADD COLUMN     "chunkingVersion" INTEGER;

-- AlterTable
ALTER TABLE "project_rag_settings" ADD COLUMN     "chunkByContentType" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "chunkProfiles" JSONB,
ADD COLUMN     "chunkingVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "workspace_rag_settings" ADD COLUMN     "chunkByContentType" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "chunkProfiles" JSONB;

-- CreateTable
CREATE TABLE "project_chunking_run" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" "ProjectChunkingRunKind" NOT NULL,
    "status" "ProjectChunkingRunStatus" NOT NULL DEFAULT 'RUNNING',
    "chunkingVersion" INTEGER,
    "workflowId" TEXT,
    "progress" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_chunking_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_chunking_run_projectId_kind_startedAt_idx" ON "project_chunking_run"("projectId", "kind", "startedAt");

-- CreateIndex
CREATE INDEX "project_chunking_run_organizationId_idx" ON "project_chunking_run"("organizationId");

-- CreateIndex
CREATE INDEX "project_chunking_run_userId_idx" ON "project_chunking_run"("userId");

-- AddForeignKey
ALTER TABLE "project_chunking_run" ADD CONSTRAINT "project_chunking_run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_chunking_run" ADD CONSTRAINT "project_chunking_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_chunking_run" ADD CONSTRAINT "project_chunking_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
