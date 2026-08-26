-- AlterTable: per-decision current version counter (comments tag the version they were posted on)
ALTER TABLE "architecture_decision" ADD COLUMN "currentVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable: the decision version current when a comment was posted (continuous thread, tagged)
ALTER TABLE "architecture_decision_comment" ADD COLUMN "decisionVersion" INTEGER;
