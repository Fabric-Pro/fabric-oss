-- CreateEnum
CREATE TYPE "meeting_agenda_status" AS ENUM ('GENERATING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "project_meeting_agenda" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "linkedMeetingId" TEXT NOT NULL,
    "occurrenceStart" TIMESTAMP(3) NOT NULL,
    "status" "meeting_agenda_status" NOT NULL DEFAULT 'GENERATING',
    "content" TEXT,
    "generatedStructure" JSONB,
    "contextStats" JSONB,
    "generatedAt" TIMESTAMP(3),
    "generationError" TEXT,
    "temporalWorkflowId" TEXT,
    "editedAt" TIMESTAMP(3),
    "editedById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "project_meeting_agenda_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_meeting_agenda_linkedMeetingId_occurrenceStart_key"
    ON "project_meeting_agenda"("linkedMeetingId", "occurrenceStart");

-- CreateIndex
CREATE INDEX "project_meeting_agenda_projectId_occurrenceStart_idx"
    ON "project_meeting_agenda"("projectId", "occurrenceStart");

-- AddForeignKey
ALTER TABLE "project_meeting_agenda" ADD CONSTRAINT "project_meeting_agenda_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_meeting_agenda" ADD CONSTRAINT "project_meeting_agenda_linkedMeetingId_fkey"
    FOREIGN KEY ("linkedMeetingId") REFERENCES "project_linked_meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_meeting_agenda" ADD CONSTRAINT "project_meeting_agenda_editedById_fkey"
    FOREIGN KEY ("editedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
