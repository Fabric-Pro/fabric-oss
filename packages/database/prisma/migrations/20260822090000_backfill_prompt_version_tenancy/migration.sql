-- Backfill PromptVersion tenancy from its parent Prompt.
--
-- The version row is documented to mirror the parent Prompt's XOR tenancy
-- exactly ("TENANT ISOLATION: version row must mirror parent Prompt's tenancy"),
-- because scope-based access checks and RLS read the VERSION, not the parent.
-- Rows written before that rule existed — including every version the system
-- prompt seed created — carry NULL scope/user_id/organization_id, which makes
-- them unreachable for binding at a shared tier even when their parent is a
-- public SYSTEM prompt. Copy the parent's tenancy into every version row that
-- lacks it.

UPDATE "prompt_version" AS pv
SET "scope"           = p."scope",
    "userId"          = p."userId",
    "organizationId"  = p."organizationId"
FROM "prompt" AS p
WHERE pv."promptId" = p."id"
  AND pv."scope" IS NULL
  AND pv."userId" IS NULL
  AND pv."organizationId" IS NULL;
