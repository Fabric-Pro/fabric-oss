-- Sync migration for drift from epic, feature, data_connection, project_document, user_story changes
-- These changes already exist in the database but were missing from migration history

-- DropIndex (if exists)
DROP INDEX IF EXISTS "public"."data_connection_organizationId_provider_key";
DROP INDEX IF EXISTS "public"."data_connection_userId_provider_key";

-- AlterTable data_connection (add columns if not exists)
ALTER TABLE "data_connection" ADD COLUMN IF NOT EXISTS "externalWorkspaceId" TEXT;
ALTER TABLE "data_connection" ADD COLUMN IF NOT EXISTS "externalWorkspaceName" TEXT;

-- AlterTable project_document (add columns if not exists)
ALTER TABLE "project_document" ADD COLUMN IF NOT EXISTS "contentHash" TEXT;
ALTER TABLE "project_document" ADD COLUMN IF NOT EXISTS "embeddedAt" TIMESTAMP(3);
ALTER TABLE "project_document" ADD COLUMN IF NOT EXISTS "qdrantId" TEXT;

-- AlterTable user_story (add columns if not exists)
ALTER TABLE "user_story" ADD COLUMN IF NOT EXISTS "featureId" TEXT;
ALTER TABLE "user_story" ADD COLUMN IF NOT EXISTS "releaseNotes" TEXT;

-- CreateTable epic (if not exists)
CREATE TABLE IF NOT EXISTS "epic" (
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

-- CreateTable feature (if not exists)
CREATE TABLE IF NOT EXISTS "feature" (
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

-- CreateIndex (if not exists)
CREATE INDEX IF NOT EXISTS "epic_projectId_idx" ON "epic"("projectId");
CREATE INDEX IF NOT EXISTS "epic_createdById_idx" ON "epic"("createdById");
CREATE INDEX IF NOT EXISTS "feature_projectId_idx" ON "feature"("projectId");
CREATE INDEX IF NOT EXISTS "feature_epicId_idx" ON "feature"("epicId");
CREATE INDEX IF NOT EXISTS "feature_createdById_idx" ON "feature"("createdById");
CREATE UNIQUE INDEX IF NOT EXISTS "data_connection_userId_provider_externalWorkspaceId_key" ON "data_connection"("userId", "provider", "externalWorkspaceId");
CREATE UNIQUE INDEX IF NOT EXISTS "data_connection_organizationId_provider_externalWorkspaceId_key" ON "data_connection"("organizationId", "provider", "externalWorkspaceId");
CREATE INDEX IF NOT EXISTS "project_document_qdrantId_idx" ON "project_document"("qdrantId");
CREATE INDEX IF NOT EXISTS "user_story_featureId_idx" ON "user_story"("featureId");

-- AddForeignKey (only if not exists)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'epic_projectId_fkey') THEN
        ALTER TABLE "epic" ADD CONSTRAINT "epic_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_projectId_fkey') THEN
        ALTER TABLE "feature" ADD CONSTRAINT "feature_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_epicId_fkey') THEN
        ALTER TABLE "feature" ADD CONSTRAINT "feature_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "epic"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_story_featureId_fkey') THEN
        ALTER TABLE "user_story" ADD CONSTRAINT "user_story_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "feature"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
