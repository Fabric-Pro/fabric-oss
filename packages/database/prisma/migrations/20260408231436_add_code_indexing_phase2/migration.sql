-- CreateEnum
CREATE TYPE "CodeIndexStatus" AS ENUM ('PENDING', 'INDEXING', 'READY', 'STALE', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ProjectContextType" ADD VALUE 'CODE_FILE';
ALTER TYPE "ProjectContextType" ADD VALUE 'CODE_FILE_SUMMARY';

-- AlterTable
ALTER TABLE "project_rag_settings" ADD COLUMN     "codeEmbeddingModel" TEXT DEFAULT 'TEXT_EMBEDDING_3_SMALL';

-- CreateTable
CREATE TABLE "project_code_index" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "filesIndexed" INTEGER NOT NULL DEFAULT 0,
    "chunksCreated" INTEGER NOT NULL DEFAULT 0,
    "summariesCreated" INTEGER NOT NULL DEFAULT 0,
    "indexedAt" TIMESTAMP(3) NOT NULL,
    "indexDurationMs" INTEGER,
    "status" "CodeIndexStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "lastFullIndexAt" TIMESTAMP(3),
    "lastIncrementalAt" TIMESTAMP(3),
    "fileManifest" JSONB,
    "redactionManifest" JSONB,
    "workflowId" TEXT,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_code_index_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_code_index_projectId_key" ON "project_code_index"("projectId");

-- CreateIndex
CREATE INDEX "project_code_index_userId_idx" ON "project_code_index"("userId");

-- CreateIndex
CREATE INDEX "project_code_index_organizationId_idx" ON "project_code_index"("organizationId");

-- CreateIndex
CREATE INDEX "project_code_index_status_idx" ON "project_code_index"("status");

-- AddForeignKey
ALTER TABLE "project_code_index" ADD CONSTRAINT "project_code_index_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_code_index" ADD CONSTRAINT "project_code_index_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_code_index" ADD CONSTRAINT "project_code_index_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
