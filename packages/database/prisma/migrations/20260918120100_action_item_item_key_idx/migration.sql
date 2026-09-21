-- Index for project_meeting_action_item.itemKey (Fizzy #2340).
--
-- Alone in its own migration and CONCURRENTLY: a CREATE INDEX on an existing,
-- non-empty table is rejected by the migration linter otherwise, and a
-- concurrent build cannot run inside a transaction block.
--
-- Supports joining a to-do to its live action item by key, which is what lets an
-- organization-wide list filter and order on completion in SQL instead of
-- hashing every action item of every in-scope meeting in memory.

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "project_meeting_action_item_transcriptId_itemKey_idx" ON "project_meeting_action_item"("transcriptId", "itemKey");
