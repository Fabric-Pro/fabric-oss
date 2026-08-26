-- Pipeline-run "who ran" (CI actor) + full per-test breakdown for the in-portal
-- run-detail view. All nullable / additive — safe to apply online.

-- AlterTable
ALTER TABLE "test_pipeline_run" ADD COLUMN     "triggeredByActor" TEXT,
ADD COLUMN     "triggeredByActorAvatarUrl" TEXT,
ADD COLUMN     "results" JSONB;
