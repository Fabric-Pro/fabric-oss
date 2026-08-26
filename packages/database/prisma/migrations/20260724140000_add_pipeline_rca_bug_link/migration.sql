-- Card 1688: RCA — turn a red automated-test result into a tracked BUG.
-- Additive only. New StorySource value + a per-project opt-in toggle (default
-- OFF, so failures never auto-create bugs unless a project turns it on) + a
-- nullable link/dedup column tying a pipeline-failure bug to its test case.

-- New creation origin for bugs opened from a red pipeline result. Not referenced
-- in this migration's DDL, so the ADD VALUE stays transaction-safe on PG12+.
ALTER TYPE "StorySource" ADD VALUE IF NOT EXISTS 'PIPELINE_FAILURE';

-- Per-project opt-in: when ON, ingesting a run that turns a linked case FAILED
-- opens a BUG for it (unless one is already open). Default OFF so existing
-- projects see no behavior change and the backlog is never flooded.
ALTER TABLE "project" ADD COLUMN "autoCreateBugsFromFailures" BOOLEAN NOT NULL DEFAULT false;

-- Links a pipeline-failure bug to the test case it was opened for; also the
-- dedup key (one OPEN bug per case). Nullable — every other story leaves it null.
ALTER TABLE "user_story" ADD COLUMN "originTestCaseId" TEXT;

-- Serves the RCA dedup lookup ("is there already a bug for this test case?").
CREATE INDEX "user_story_originTestCaseId_idx" ON "user_story"("originTestCaseId");
