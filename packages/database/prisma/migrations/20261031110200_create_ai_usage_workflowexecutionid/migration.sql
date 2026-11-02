-- Keep usage accounting writable during the partial index build.
CREATE INDEX CONCURRENTLY "ai_usage_log_workflowExecutionId_createdAt_not_null_idx" ON "ai_usage_log"("workflowExecutionId", "createdAt") WHERE "workflowExecutionId" IS NOT NULL;
