-- Nullable origins preserve existing rows and permit old and new writers together.
-- No backfill: a conversation id cannot establish a Workspace or workflow origin.
ALTER TABLE "ai_usage_log"
  ADD COLUMN "frameId" TEXT,
  ADD COLUMN "workflowExecutionId" TEXT;

ALTER TABLE "ai_usage_log"
  ADD CONSTRAINT "ai_usage_log_frameId_fkey"
  FOREIGN KEY ("frameId") REFERENCES "agent_workspace_file"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "ai_usage_log_workflowExecutionId_fkey"
  FOREIGN KEY ("workflowExecutionId") REFERENCES "workflow_execution"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
