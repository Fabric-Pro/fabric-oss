-- AlterTable
-- Shared, project-wide manual rank for the Roadmap "Priority" layout.
-- Nullable with no default on purpose: NULL means "never hand-placed", so the
-- item sits in its computed rank, and "restore the suggested order" is a plain
-- UPDATE ... SET "priorityOrder" = NULL. A DEFAULT 0 would make every untouched
-- row indistinguishable from one deliberately pinned to the top.
ALTER TABLE "user_story" ADD COLUMN "priorityOrder" DOUBLE PRECISION;
