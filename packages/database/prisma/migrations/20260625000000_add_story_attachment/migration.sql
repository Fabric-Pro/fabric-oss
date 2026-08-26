-- CreateEnum
CREATE TYPE "StoryAttachmentDesignation" AS ENUM ('LOCKED', 'UNLOCKED');

-- CreateEnum
CREATE TYPE "StoryAttachmentSource" AS ENUM ('FABRIC', 'PM_SYNCED');

-- CreateTable
CREATE TABLE "story_attachment" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "designation" "StoryAttachmentDesignation" NOT NULL DEFAULT 'LOCKED',
    "source" "StoryAttachmentSource" NOT NULL DEFAULT 'FABRIC',
    "uploaderUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "story_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "story_attachment_storageKey_key" ON "story_attachment"("storageKey");

-- CreateIndex
CREATE INDEX "story_attachment_storyId_idx" ON "story_attachment"("storyId");

-- CreateIndex
CREATE INDEX "story_attachment_uploaderUserId_idx" ON "story_attachment"("uploaderUserId");

-- AddForeignKey
ALTER TABLE "story_attachment" ADD CONSTRAINT "story_attachment_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_attachment" ADD CONSTRAINT "story_attachment_uploaderUserId_fkey" FOREIGN KEY ("uploaderUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
