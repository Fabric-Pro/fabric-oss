-- AlterTable
ALTER TABLE "story_attachment" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "story_attachment_deletedAt_idx" ON "story_attachment"("deletedAt");
