-- Background-job attribution (Fizzy #1894): per-pipeline volume/cost and
-- "system vs user" filtered views. Built CONCURRENTLY so populating the
-- column backfill-free on an already-large ai_usage_log does not take a
-- table-wide write lock.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_usage_log_jobType_createdAt_idx" ON "ai_usage_log"("jobType", "createdAt");
