-- AlterTable: Add changeNote column for version changelog notes
ALTER TABLE "prompt_version" ADD COLUMN "changeNote" TEXT;

-- Backfill: align prompt_version tenancy with the parent prompt (XOR pattern).
-- Historical rows:
--   * never had the denormalized `scope` column populated
--   * ORG prompt versions had userId = <some user> instead of NULL,
--     violating the XOR isolation contract enforced on Prompt itself
-- This UPDATE makes the denormalized columns match the parent prompt exactly.
UPDATE "prompt_version" pv
SET
  "scope" = p."scope",
  "userId" = CASE WHEN p."scope" = 'USER' THEN p."userId" ELSE NULL END,
  "organizationId" = CASE WHEN p."scope" = 'ORG' THEN p."organizationId" ELSE NULL END
FROM "prompt" p
WHERE pv."promptId" = p."id"
  AND (
    pv."scope" IS DISTINCT FROM p."scope"
    OR pv."userId" IS DISTINCT FROM (CASE WHEN p."scope" = 'USER' THEN p."userId" ELSE NULL END)
    OR pv."organizationId" IS DISTINCT FROM (CASE WHEN p."scope" = 'ORG' THEN p."organizationId" ELSE NULL END)
  );
