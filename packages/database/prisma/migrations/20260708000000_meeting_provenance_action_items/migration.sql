-- #1814: meeting provenance on stories + first-class action items

ALTER TABLE "user_story" ADD COLUMN "sourceMeetingTranscriptId" TEXT;

CREATE INDEX "user_story_sourceMeetingTranscriptId_idx"
  ON "user_story"("sourceMeetingTranscriptId");

ALTER TABLE "user_story"
  ADD CONSTRAINT "user_story_sourceMeetingTranscriptId_fkey"
  FOREIGN KEY ("sourceMeetingTranscriptId")
  REFERENCES "project_meeting_transcript"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "project_meeting_action_item" (
  "id" TEXT NOT NULL,
  "transcriptId" TEXT NOT NULL,
  "orderIndex" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "tentativeOwnerName" TEXT,
  "dueHint" TEXT,
  "completedAt" TIMESTAMP(3),
  "completedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId" TEXT,
  "organizationId" TEXT,
  CONSTRAINT "project_meeting_action_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_meeting_action_item_transcriptId_orderIndex_key"
  ON "project_meeting_action_item"("transcriptId", "orderIndex");
CREATE INDEX "project_meeting_action_item_transcriptId_idx"
  ON "project_meeting_action_item"("transcriptId");
CREATE INDEX "project_meeting_action_item_userId_idx"
  ON "project_meeting_action_item"("userId");
CREATE INDEX "project_meeting_action_item_organizationId_idx"
  ON "project_meeting_action_item"("organizationId");

ALTER TABLE "project_meeting_action_item"
  ADD CONSTRAINT "project_meeting_action_item_transcriptId_fkey"
  FOREIGN KEY ("transcriptId") REFERENCES "project_meeting_transcript"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_meeting_action_item"
  ADD CONSTRAINT "project_meeting_action_item_completedById_fkey"
  FOREIGN KEY ("completedById") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
