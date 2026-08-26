/*
  Warnings:

  - A unique constraint covering the columns `[userId,provider,externalWorkspaceId]` on the table `data_connection` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[organizationId,provider,externalWorkspaceId]` on the table `data_connection` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "public"."data_connection_organizationId_provider_key";

-- DropIndex
DROP INDEX "public"."data_connection_userId_provider_key";

-- AlterTable
ALTER TABLE "data_connection" ADD COLUMN     "externalWorkspaceId" TEXT,
ADD COLUMN     "externalWorkspaceName" TEXT;

-- AlterTable
ALTER TABLE "project_document" ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "embeddedAt" TIMESTAMP(3),
ADD COLUMN     "qdrantId" TEXT;

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "featureId" TEXT,
ADD COLUMN     "releaseNotes" TEXT;

-- CreateTable
CREATE TABLE "epic" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "epic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "epicId" TEXT,
    "identifier" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "epic_projectId_idx" ON "epic"("projectId");

-- CreateIndex
CREATE INDEX "epic_createdById_idx" ON "epic"("createdById");

-- CreateIndex
CREATE INDEX "feature_projectId_idx" ON "feature"("projectId");

-- CreateIndex
CREATE INDEX "feature_epicId_idx" ON "feature"("epicId");

-- CreateIndex
CREATE INDEX "feature_createdById_idx" ON "feature"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "data_connection_userId_provider_externalWorkspaceId_key" ON "data_connection"("userId", "provider", "externalWorkspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "data_connection_organizationId_provider_externalWorkspaceId_key" ON "data_connection"("organizationId", "provider", "externalWorkspaceId");

-- CreateIndex
CREATE INDEX "project_document_qdrantId_idx" ON "project_document"("qdrantId");

-- CreateIndex
CREATE INDEX "user_story_featureId_idx" ON "user_story"("featureId");

-- AddForeignKey
ALTER TABLE "epic" ADD CONSTRAINT "epic_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature" ADD CONSTRAINT "feature_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature" ADD CONSTRAINT "feature_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "epic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_story" ADD CONSTRAINT "user_story_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "feature"("id") ON DELETE SET NULL ON UPDATE CASCADE;
