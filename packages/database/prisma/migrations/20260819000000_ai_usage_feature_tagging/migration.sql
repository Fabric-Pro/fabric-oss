-- AI feature adoption analytics, Phase 1 (Fizzy #2230): attribute each model
-- call to the user-facing feature that made it and the resolved prompt version
-- it ran with, so acceptance metrics can be segmented by model x prompt.
--
-- Both columns are nullable with no default, so the add is a catalog-only
-- change that takes no table rewrite. Untagged call sites write NULL; tag
-- coverage grows incrementally — NULL means "untagged", never "no feature".
--
-- The covering index lands in its own follow-up migration: ai_usage_log is a
-- large, write-hot table, and a plain CREATE INDEX would hold a write lock for
-- the whole build.
ALTER TABLE "ai_usage_log" ADD COLUMN "featureKey" TEXT;
ALTER TABLE "ai_usage_log" ADD COLUMN "promptVersionId" TEXT;
