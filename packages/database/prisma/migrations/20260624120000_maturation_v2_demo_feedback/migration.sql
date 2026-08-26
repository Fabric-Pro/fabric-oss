-- Feature Maturation V2 — demo feedback (2026-06-24).
-- #2/#3: staleness signal for the "Update using context" / "Refresh Clean Spec"
--        control. #4a: summary-regeneration gate. #5: soft-close reconciliation.

-- AlterEnum: soft-close status for questions a refresh no longer lists (#5).
-- Safe inside the migration transaction — the value is added but not used here.
ALTER TYPE "decision_status" ADD VALUE IF NOT EXISTS 'POSSIBLY_RESOLVED';

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "lastSummaryHash" TEXT;
ALTER TABLE "user_story" ADD COLUMN     "lastContextUpdateAt" TIMESTAMP(3);

-- Backfill lastContextUpdateAt from the most recent FeatureVersion per story as a
-- one-time approximation of "last context refresh" for pre-existing features. Rows
-- with no version history stay NULL (treated as "never refreshed" → neutral, not
-- stale). Manual-edit versions can inflate this slightly; accepted per spec.
UPDATE "user_story" AS us
SET "lastContextUpdateAt" = fv.max_created
FROM (
  SELECT "storyId", MAX("createdAt") AS max_created
  FROM "feature_version"
  GROUP BY "storyId"
) AS fv
WHERE fv."storyId" = us."id";
