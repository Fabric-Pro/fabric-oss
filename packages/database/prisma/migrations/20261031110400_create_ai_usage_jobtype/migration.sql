-- Keep usage accounting writable during the partial index build.
CREATE INDEX CONCURRENTLY "ai_usage_log_jobType_createdAt_not_null_idx" ON "ai_usage_log"("jobType", "createdAt") WHERE "jobType" IS NOT NULL;
