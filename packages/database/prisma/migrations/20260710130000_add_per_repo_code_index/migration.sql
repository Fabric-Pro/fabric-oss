-- Per-repo code index: one ProjectCodeIndex row per connected repository
-- integration (instead of one per project). Mirrors AtlasAnalysis.

-- 1. New columns. repositoryIntegrationId is null for legacy rows (the project's
--    default repositoryUrl). branch defaults to "main".
ALTER TABLE "project_code_index" ADD COLUMN "repositoryIntegrationId" TEXT;
ALTER TABLE "project_code_index" ADD COLUMN "branch" TEXT NOT NULL DEFAULT 'main';

-- 2. Backfill: today's index is single-repo (only the project's primary repo was
--    ever indexed), so map each existing row to its matching ACTIVE integration by
--    owner/name. Also align `branch` with that integration's default branch so a
--    later re-index / webhook (which keys on the integration's default branch)
--    updates this same row instead of creating an orphan. Unmatched rows stay
--    null (legacy) on branch "main" and keep working.
UPDATE "project_code_index" pci
SET "repositoryIntegrationId" = pri."id",
    "branch" = COALESCE(pri."defaultBranch", 'main')
FROM "project" p
JOIN "project_repository_integration" pri
  ON pri."projectId" = p."id"
  AND pri."repositoryOwner" = p."repositoryOwner"
  AND pri."repositoryName" = p."repositoryName"
  AND pri."status" = 'ACTIVE'
WHERE pci."projectId" = p."id";

-- 3. Swap the old projectId-unique for the composite unique. (Non-null branch
--    mirrors AtlasAnalysis; the code always writes a non-null repositoryIntegrationId
--    for new rows, so at most one legacy null row exists per project after backfill.)
DROP INDEX "project_code_index_projectId_key";
CREATE UNIQUE INDEX "project_code_index_projectId_repositoryIntegrationId_branch_key"
  ON "project_code_index"("projectId", "repositoryIntegrationId", "branch");

-- 4. Lookup indexes.
CREATE INDEX "project_code_index_projectId_idx" ON "project_code_index"("projectId");
CREATE INDEX "project_code_index_repositoryIntegrationId_idx" ON "project_code_index"("repositoryIntegrationId");
