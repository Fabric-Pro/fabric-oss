-- Per-branch Atlas analysis persistence: one CodeUnderstandingAnalysis row per
-- (project, repository integration, BRANCH), so switching the monitored branch
-- and back restores the already-analysed map instead of overwriting it.
-- Existing rows are 1-per-(project, repo), so no dedup/backfill is needed;
-- NULL repositoryIntegrationId values remain distinct under Postgres unique
-- semantics, exactly as before.

-- DropIndex
DROP INDEX "code_understanding_analysis_projectId_repositoryIntegration_key";

-- CreateIndex
CREATE UNIQUE INDEX "code_understanding_analysis_projectId_repositoryIntegration_key" ON "code_understanding_analysis"("projectId", "repositoryIntegrationId", "branch");
