-- CreateEnum
CREATE TYPE "MeetingTranscriptAnalysisStatus" AS ENUM ('NOT_SCANNED', 'IN_PROGRESS', 'SCANNED', 'FAILED');

-- AlterTable: per-transcript auto-analysis scan-status lifecycle
ALTER TABLE "project_meeting_transcript"
  ADD COLUMN "analysisStatus" "MeetingTranscriptAnalysisStatus" NOT NULL DEFAULT 'NOT_SCANNED',
  ADD COLUMN "analysisStartedAt" TIMESTAMP(3),
  ADD COLUMN "analysisError" TEXT,
  ADD COLUMN "analysisFailedAt" TIMESTAMP(3);

-- Backfill: transcripts that already finished analysis (analyzedAt set) are SCANNED.
-- Everything else keeps the NOT_SCANNED default.
UPDATE "project_meeting_transcript"
  SET "analysisStatus" = 'SCANNED'
  WHERE "analyzedAt" IS NOT NULL;
