-- Feature Maturation V2 — AI answer recommendations (demo feedback #7).

-- CreateEnum
CREATE TYPE "answer_source" AS ENUM ('AI_SUGGESTED', 'AI_EDITED', 'MANUAL');

-- AlterTable: per-feature auto-propose toggle (ON by default; disable per-feature).
ALTER TABLE "user_story" ADD COLUMN "autoProposeAnswers" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: queryable origin of a settled answer relative to the AI recommendation.
-- Nullable: OPEN question roots and pre-existing rows carry NULL.
ALTER TABLE "decision_log_entry" ADD COLUMN "answerSource" "answer_source";
