-- Inverted loop (Slice 3): frames listed per feature. Built CONCURRENTLY in its
-- own migration so "agent_workspace_file" is not write-locked.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_workspace_file_storyId_idx" ON "agent_workspace_file"("storyId");
