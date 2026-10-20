-- One statement: Prisma must not wrap a concurrent index build in a transaction.
CREATE INDEX CONCURRENTLY "ai_usage_log_workflowExecutionId_createdAt_idx" ON "ai_usage_log"("workflowExecutionId", "createdAt");
