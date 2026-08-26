-- QA pipeline-results branch override, per connected repository.
--
-- NULL means "follow defaultBranch", which is exactly today's behaviour, so this
-- is additive and needs no backfill: every existing row keeps syncing the branch
-- it already synced. Kept separate from defaultBranch because that column also
-- drives code indexing — a team whose CI publishes test reports on `develop`
-- must be able to move QA there without moving what Atlas indexes.
ALTER TABLE "project_repository_integration" ADD COLUMN "qaBranch" TEXT;
