-- Drop the global unique constraint on draftKey (was wrong — should be per-user+org, not global)
DROP INDEX IF EXISTS "project_draftKey_key";

-- Drop the non-unique composite index if it exists
DROP INDEX IF EXISTS "project_userId_draftKey_idx";

-- Add unique constraint: one draft per (userId, draftKey, organizationId)
-- PostgreSQL treats NULLs as distinct, so personal (orgId=NULL) and org contexts don't conflict
CREATE UNIQUE INDEX "project_userId_draftKey_orgId_key" ON "project"("userId", "draftKey", "organizationId");
