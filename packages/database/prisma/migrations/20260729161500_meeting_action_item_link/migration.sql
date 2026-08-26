-- CreateEnum
CREATE TYPE "meeting_action_item_link_origin" AS ENUM ('AUTO', 'MANUAL', 'CREATED');

-- CreateEnum
CREATE TYPE "meeting_action_item_link_status" AS ENUM ('ACTIVE', 'DISMISSED');

-- AlterTable
ALTER TABLE "project_meeting_transcript" ADD COLUMN     "actionItemsLinkVersion" INTEGER,
ADD COLUMN     "actionItemsLinkedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "meeting_action_item_link" (
    "id" TEXT NOT NULL,
    "transcriptId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "itemTextSnapshot" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "origin" "meeting_action_item_link_origin" NOT NULL,
    "status" "meeting_action_item_link_status" NOT NULL DEFAULT 'ACTIVE',
    "similarity" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "reasoning" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMP(3),
    "dismissedById" TEXT,
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "meeting_action_item_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meeting_action_item_link_storyId_idx" ON "meeting_action_item_link"("storyId");

-- CreateIndex
CREATE INDEX "meeting_action_item_link_transcriptId_status_idx" ON "meeting_action_item_link"("transcriptId", "status");

-- CreateIndex
CREATE INDEX "meeting_action_item_link_projectId_idx" ON "meeting_action_item_link"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_action_item_link_transcriptId_itemKey_storyId_key" ON "meeting_action_item_link"("transcriptId", "itemKey", "storyId");

-- AddForeignKey
ALTER TABLE "meeting_action_item_link" ADD CONSTRAINT "meeting_action_item_link_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "project_meeting_transcript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_action_item_link" ADD CONSTRAINT "meeting_action_item_link_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_action_item_link" ADD CONSTRAINT "meeting_action_item_link_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

