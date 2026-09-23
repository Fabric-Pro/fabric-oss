-- AlterTable
-- AI-recommended item lifecycle: the batch an item was accepted from, whether a
-- person protected it from batch removal, and when a person first edited its
-- content. All nullable with no default, so existing rows are untouched and no
-- table rewrite happens. No index: every read filters by projectId first.
ALTER TABLE "user_story" ADD COLUMN     "aiRecommendationBatchId" TEXT,
ADD COLUMN     "aiBatchProtectedAt" TIMESTAMP(3),
ADD COLUMN     "aiBatchProtectedById" TEXT,
ADD COLUMN     "firstHumanEditAt" TIMESTAMP(3);
