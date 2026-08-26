-- Roadmap "Priority" view: per-work-item priority-band change history.
--
-- One row per ACTUAL band change. A re-prioritization run that leaves an
-- item's band unchanged writes nothing, so this table records movement rather
-- than every evaluation.

-- CreateEnum
CREATE TYPE "PriorityChangeSource" AS ENUM ('AI', 'MANUAL');

-- AlterTable: denormalised "last priority change" stamp so the Priority list
-- renders "set <when>" per row without joining the history table.
ALTER TABLE "user_story" ADD COLUMN "priorityChangedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "story_priority_change" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fromPriority" "StoryPriority",
    "toPriority" "StoryPriority" NOT NULL,
    "source" "PriorityChangeSource" NOT NULL,
    "reason" TEXT,
    "actorId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_priority_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: the per-row history read (one story, newest first, cursored).
CREATE INDEX "story_priority_change_storyId_createdAt_idx" ON "story_priority_change"("storyId", "createdAt" DESC);

-- CreateIndex: project-wide sweeps.
CREATE INDEX "story_priority_change_projectId_createdAt_idx" ON "story_priority_change"("projectId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "story_priority_change" ADD CONSTRAINT "story_priority_change_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "user_story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_priority_change" ADD CONSTRAINT "story_priority_change_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_priority_change" ADD CONSTRAINT "story_priority_change_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
