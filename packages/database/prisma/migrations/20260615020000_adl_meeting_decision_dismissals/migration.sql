-- AlterTable: track dismissed meeting-decision candidates so they aren't re-suggested
ALTER TABLE "project_meeting_transcript" ADD COLUMN "dismissedDecisionIndexes" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
