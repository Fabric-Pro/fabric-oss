-- Records the survivor a story was merged into when discarded by a
-- duplicate-merge. Additive + nullable + no default, so every existing row is
-- untouched (no backfill, no table rewrite, no lock). Drives the roadmap
-- "Declined duplicate" chip + "Merged into {identifier}" tooltip.
-- AlterTable
ALTER TABLE "user_story" ADD COLUMN "mergedIntoStoryId" TEXT;
