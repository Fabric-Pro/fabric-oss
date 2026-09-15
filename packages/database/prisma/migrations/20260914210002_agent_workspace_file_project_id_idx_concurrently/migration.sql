-- Inverted loop (Slice 3): project-scoped frames (spike demos) lookup. Built
-- CONCURRENTLY in its own migration so "agent_workspace_file" is not write-locked.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_workspace_file_projectId_idx" ON "agent_workspace_file"("projectId");
