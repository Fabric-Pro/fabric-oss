-- The unique constraint grows a column; drop the old one before building its
-- replacement. CONCURRENTLY so a populated table is not locked for the drop.
-- migration-lint: allow destructive-without-marker — the replacement unique
-- (prompt_binding_targetType_targetKey_documentType_storyKind_projectId_key,
-- previous migration) is already in place, so this index is redundant from the
-- moment the widen lands; no running version reads it for uniqueness.
DROP INDEX CONCURRENTLY IF EXISTS "prompt_binding_targetType_targetKey_documentType_storyKind__key";
