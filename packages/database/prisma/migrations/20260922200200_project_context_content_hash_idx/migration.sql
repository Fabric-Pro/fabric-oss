-- The synced-file path's duplicate check (Fizzy #2616): "is this exact content
-- already in the project under another path?" is a lookup on (projectId,
-- contentHash) on every push of a new path.
--
-- Alone in its own migration and CONCURRENTLY for the same reason as the
-- unique index before it: project_context is populated, and a concurrent build
-- cannot run inside a transaction block.
CREATE INDEX CONCURRENTLY "project_context_projectId_contentHash_idx" ON "project_context"("projectId", "contentHash");
