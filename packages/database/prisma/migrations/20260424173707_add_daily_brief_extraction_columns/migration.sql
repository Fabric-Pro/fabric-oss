-- AlterTable
ALTER TABLE "project_meeting_transcript" ADD COLUMN     "extractedActionItems" JSONB,
ADD COLUMN     "extractedDecisions" JSONB,
ADD COLUMN     "extractedQuestions" JSONB,
ADD COLUMN     "insightsExtractedAt" TIMESTAMP(3),
ADD COLUMN     "insightsVersion" INTEGER;
