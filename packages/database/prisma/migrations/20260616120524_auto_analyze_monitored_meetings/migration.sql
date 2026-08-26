-- AlterEnum
ALTER TYPE "PendingBacklogProposalSource" ADD VALUE 'MONITORED_MEETING';

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "meetingTranscriptAutoAnalyzeEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "project_meeting_transcript" ADD COLUMN     "analyzedAt" TIMESTAMP(3),
ADD COLUMN     "analyzedProposalId" TEXT;
