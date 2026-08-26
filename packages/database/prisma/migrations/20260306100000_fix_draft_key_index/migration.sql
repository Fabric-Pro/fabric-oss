-- Drop the global unique constraint on draftKey (was wrong — should be per-user, not global)
DROP INDEX IF EXISTS "project_draftKey_key";

-- Ensure the composite (userId, draftKey) index exists (created by prior migration, idempotent)
CREATE INDEX IF NOT EXISTS "project_userId_draftKey_idx" ON "project"("userId", "draftKey");
