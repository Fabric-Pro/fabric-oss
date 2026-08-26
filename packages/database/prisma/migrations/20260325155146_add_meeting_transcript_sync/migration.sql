-- AlterEnum
ALTER TYPE "ProjectContextType" ADD VALUE 'MEETING_TRANSCRIPT';

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "meetingTranscriptSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "meetingTranscriptSyncIntervalMin" INTEGER,
ADD COLUMN     "meetingTranscriptSyncLastRun" TIMESTAMP(3),
ADD COLUMN     "meetingTranscriptSyncWorkflowId" TEXT;

-- CreateTable
CREATE TABLE "project_linked_meeting" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "joinUrl" TEXT NOT NULL,
    "subject" TEXT,
    "organizer" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "project_linked_meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_meeting_transcript" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkedMeetingId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "transcriptId" TEXT NOT NULL,
    "meetingSubject" TEXT,
    "meetingDate" TIMESTAMP(3),
    "contextId" TEXT,
    "summary" TEXT,
    "keywords" TEXT[],
    "speakerNames" TEXT[],
    "contentLength" INTEGER,
    "wasSummarized" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "project_meeting_transcript_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_linked_meeting_projectId_idx" ON "project_linked_meeting"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_linked_meeting_projectId_joinUrl_key" ON "project_linked_meeting"("projectId", "joinUrl");

-- CreateIndex
CREATE INDEX "project_meeting_transcript_projectId_idx" ON "project_meeting_transcript"("projectId");

-- CreateIndex
CREATE INDEX "project_meeting_transcript_linkedMeetingId_idx" ON "project_meeting_transcript"("linkedMeetingId");

-- CreateIndex
CREATE INDEX "project_meeting_transcript_meetingDate_idx" ON "project_meeting_transcript"("meetingDate");

-- CreateIndex
CREATE UNIQUE INDEX "project_meeting_transcript_projectId_meetingId_transcriptId_key" ON "project_meeting_transcript"("projectId", "meetingId", "transcriptId");

-- AddForeignKey
ALTER TABLE "project_linked_meeting" ADD CONSTRAINT "project_linked_meeting_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_linked_meeting" ADD CONSTRAINT "project_linked_meeting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_linked_meeting" ADD CONSTRAINT "project_linked_meeting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_meeting_transcript" ADD CONSTRAINT "project_meeting_transcript_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_meeting_transcript" ADD CONSTRAINT "project_meeting_transcript_linkedMeetingId_fkey" FOREIGN KEY ("linkedMeetingId") REFERENCES "project_linked_meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_meeting_transcript" ADD CONSTRAINT "project_meeting_transcript_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_meeting_transcript" ADD CONSTRAINT "project_meeting_transcript_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
