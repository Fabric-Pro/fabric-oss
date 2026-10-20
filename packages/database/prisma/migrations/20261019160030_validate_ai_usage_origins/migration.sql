-- Separate from ADD COLUMN/CONSTRAINT so validation does not retain its
-- ACCESS EXCLUSIVE lock while scanning the existing usage history.
ALTER TABLE "ai_usage_log" VALIDATE CONSTRAINT "ai_usage_log_frameId_fkey";
ALTER TABLE "ai_usage_log" VALIDATE CONSTRAINT "ai_usage_log_workflowExecutionId_fkey";
