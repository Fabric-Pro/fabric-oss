-- Incremental duplicate-scan support. Additive + safe: a new nullable column on
-- "project" and a new "story_duplicate_embedding" cache table. No backfill, no
-- table rewrite, no lock on existing rows. An empty cache makes the first scan
-- behave exactly like a full scan and populate the cache.

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "lastDuplicateScanAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "story_duplicate_embedding" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "story_duplicate_embedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "story_duplicate_embedding_storyId_key" ON "story_duplicate_embedding"("storyId");

-- CreateIndex
CREATE INDEX "story_duplicate_embedding_projectId_idx" ON "story_duplicate_embedding"("projectId");

-- AddForeignKey
ALTER TABLE "story_duplicate_embedding" ADD CONSTRAINT "story_duplicate_embedding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_duplicate_embedding" ADD CONSTRAINT "story_duplicate_embedding_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;
