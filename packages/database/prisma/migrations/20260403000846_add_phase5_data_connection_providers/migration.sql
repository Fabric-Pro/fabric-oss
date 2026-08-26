-- CreateEnum
CREATE TYPE "ChatArtifactType" AS ENUM ('RESEARCH_REPORT', 'CODE', 'DOCUMENT', 'DATA', 'CHART', 'FILE', 'SUMMARY');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DataConnectionProvider" ADD VALUE 'GMAIL';
ALTER TYPE "DataConnectionProvider" ADD VALUE 'MICROSOFT_365';
ALTER TYPE "DataConnectionProvider" ADD VALUE 'SALESFORCE';
ALTER TYPE "DataConnectionProvider" ADD VALUE 'HUBSPOT';

-- CreateTable
CREATE TABLE "chat_artifact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "conversationId" TEXT,
    "instanceId" TEXT,
    "projectId" TEXT,
    "type" "ChatArtifactType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "content" TEXT,
    "mimeType" TEXT NOT NULL DEFAULT 'text/markdown',
    "s3Path" TEXT,
    "s3Bucket" TEXT,
    "fileSize" INTEGER,
    "metadata" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "parentId" TEXT,
    "indexedAt" TIMESTAMP(3),
    "qdrantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_artifact_userId_organizationId_idx" ON "chat_artifact"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "chat_artifact_conversationId_idx" ON "chat_artifact"("conversationId");

-- CreateIndex
CREATE INDEX "chat_artifact_projectId_idx" ON "chat_artifact"("projectId");

-- CreateIndex
CREATE INDEX "chat_artifact_type_idx" ON "chat_artifact"("type");

-- CreateIndex
CREATE INDEX "chat_artifact_createdAt_idx" ON "chat_artifact"("createdAt");

-- AddForeignKey
ALTER TABLE "chat_artifact" ADD CONSTRAINT "chat_artifact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_artifact" ADD CONSTRAINT "chat_artifact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_artifact" ADD CONSTRAINT "chat_artifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_artifact" ADD CONSTRAINT "chat_artifact_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "chat_artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
