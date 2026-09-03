-- The prompt-binding unique key enforced nothing for any row the app writes.
--
-- Postgres treats NULL as distinct from NULL in a plain unique index, and every
-- real binding shape carries at least one NULL in this key: SYSTEM rows null
-- userId/organizationId/projectId, org-wide ORG rows null userId/projectId,
-- PROJECT rows null userId, USER rows null organizationId/projectId, and every
-- non-stage binding nulls storyKind. So the constraint only ever bound a
-- fully-non-null 8-tuple, which the schema never produces.
--
-- Demonstrated on PostgreSQL 17.10 with this exact index: two identical
-- org-wide rows (scope ORG, organizationId set, userId/projectId/storyKind
-- NULL), both isDefault, pointing at different prompt versions, both INSERTed
-- without complaint. `getBoundPromptVersion` then picks between them by
-- whatever order Postgres returns, so which prompt an agent runs is undefined.
--
-- `NULLS NOT DISTINCT` (Postgres 15+; production and Aspire run 17, CI runs 16)
-- makes NULL compare equal here, which is what the key always meant. Project
-- rows still coexist with the org-wide row they narrow, because those differ in
-- projectId by a real value on one side and NULL on the other — verified.
--
-- Prisma cannot express this: its docs state NULLs "are treated as distinct"
-- and @@unique takes no nulls argument, so the index is owned here. The schema
-- keeps @@unique over the same columns with the same name; Prisma does not
-- model the modifier, so this reads as the index it expects.
--
-- Deliberately BLOCKING and in one transaction rather than CONCURRENTLY. The
-- dedupe, the drop and the rebuild have to land together: a concurrent unique
-- build that meets a duplicate leaves an INVALID index behind that silently
-- enforces nothing, which is the failure this migration exists to end. The
-- table holds one row per action per tier per tenant, so the build is short.

-- migration-lint: allow blocking-index — see the paragraph above: atomicity is
-- the point, and prompt_binding is small (one row per action, per tier, per
-- tenant). A CONCURRENTLY build cannot be transactional and, on meeting a
-- duplicate, leaves an INVALID index that enforces nothing.

-- migration-lint: allow destructive-without-marker — both destructive steps are
-- required to rebuild the key. The DELETE removes only rows that the index
-- about to be created would reject, keeping one per group (a live default over
-- a stood-down one, then most recently updated); duplicates are unreachable by
-- design, since every reader resolves a tier with findFirst and sees exactly
-- one of them already. The DROP removes the index this migration replaces
-- under the same name.

DELETE FROM "prompt_binding" victim
USING (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY
        "targetType", "targetKey", "documentType", "storyKind",
        "scope", "userId", "organizationId", "projectId"
      ORDER BY "isDefault" DESC, "updatedAt" DESC, id
    ) AS rank_in_group
  FROM "prompt_binding"
) ranked
WHERE victim.id = ranked.id
  AND ranked.rank_in_group > 1;

DROP INDEX IF EXISTS "prompt_binding_targetType_targetKey_documentType_storyKind__key";

CREATE UNIQUE INDEX "prompt_binding_targetType_targetKey_documentType_storyKind__key"
  ON "prompt_binding" (
    "targetType", "targetKey", "documentType", "storyKind",
    "scope", "userId", "organizationId", "projectId"
  )
  NULLS NOT DISTINCT;
