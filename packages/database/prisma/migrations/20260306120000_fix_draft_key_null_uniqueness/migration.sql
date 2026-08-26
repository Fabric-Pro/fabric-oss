-- Fix: PostgreSQL treats NULLs as distinct in unique indexes, so the standard
-- unique constraint on (userId, draftKey, organizationId) doesn't prevent
-- duplicate drafts in personal context (where organizationId IS NULL).
-- Replace with two partial unique indexes.

-- Drop the existing unique index
DROP INDEX IF EXISTS "project_userId_draftKey_orgId_key";

-- Org context: unique on (userId, draftKey, organizationId) where org is NOT NULL
CREATE UNIQUE INDEX "project_userId_draftKey_orgId_key"
  ON "project"("userId", "draftKey", "organizationId")
  WHERE "organizationId" IS NOT NULL AND "draftKey" IS NOT NULL;

-- Personal context: unique on (userId, draftKey) where org IS NULL
CREATE UNIQUE INDEX "project_userId_draftKey_personal_key"
  ON "project"("userId", "draftKey")
  WHERE "organizationId" IS NULL AND "draftKey" IS NOT NULL;
