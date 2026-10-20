-- Run outside a transaction: usage accounting remains writable during index builds.
CREATE INDEX CONCURRENTLY "ai_usage_log_frameId_createdAt_idx" ON "ai_usage_log"("frameId", "createdAt");
