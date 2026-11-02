-- Keep usage accounting writable during the partial index build.
CREATE INDEX CONCURRENTLY "ai_usage_log_frameId_createdAt_not_null_idx" ON "ai_usage_log"("frameId", "createdAt") WHERE "frameId" IS NOT NULL;
