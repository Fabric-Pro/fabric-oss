-- Inverted loop (Slice 4): integration contracts looked up per feature. Built
-- CONCURRENTLY in its own migration so "project_document" is not write-locked.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "project_document_storyId_idx" ON "project_document"("storyId");
