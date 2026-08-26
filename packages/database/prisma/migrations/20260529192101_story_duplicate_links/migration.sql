-- CreateEnum
CREATE TYPE "DuplicateLinkStatus" AS ENUM ('PENDING', 'DISMISSED', 'RESOLVED');

-- CreateTable
CREATE TABLE "story_duplicate_link" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "storyAId" TEXT NOT NULL,
    "storyBId" TEXT NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasoning" TEXT,
    "status" "DuplicateLinkStatus" NOT NULL DEFAULT 'PENDING',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "story_duplicate_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "story_duplicate_link_projectId_status_idx" ON "story_duplicate_link"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "story_duplicate_link_storyAId_storyBId_key" ON "story_duplicate_link"("storyAId", "storyBId");

-- AddForeignKey
ALTER TABLE "story_duplicate_link" ADD CONSTRAINT "story_duplicate_link_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_duplicate_link" ADD CONSTRAINT "story_duplicate_link_storyAId_fkey" FOREIGN KEY ("storyAId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_duplicate_link" ADD CONSTRAINT "story_duplicate_link_storyBId_fkey" FOREIGN KEY ("storyBId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;
