-- CreateTable
CREATE TABLE "story_tag" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_tag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "story_tag_storyId_idx" ON "story_tag"("storyId");

-- CreateIndex
CREATE INDEX "story_tag_createdById_idx" ON "story_tag"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "story_tag_storyId_value_key" ON "story_tag"("storyId", "value");

-- AddForeignKey
ALTER TABLE "story_tag" ADD CONSTRAINT "story_tag_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_tag" ADD CONSTRAINT "story_tag_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
