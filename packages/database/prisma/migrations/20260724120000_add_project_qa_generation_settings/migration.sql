-- AlterTable
-- Card 1878 (QA-004): per-project QA test-case generation settings.
-- generateManualTestCases gates whether any drafting run is dispatched (OFF spends no credits).
-- applyTddApproach flips the feature editor's test-case ordering (draft before implementation).
ALTER TABLE "project" ADD COLUMN     "generateManualTestCases" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "project" ADD COLUMN     "applyTddApproach" BOOLEAN NOT NULL DEFAULT false;
