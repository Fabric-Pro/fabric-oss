-- At most one personal GitLab connection row per person per organization.
--
-- The GitLab connection service treats ONE "workflow_integration" row as a
-- person's GitLab connection in an organization: provider GITLAB, no
-- workflow, not the GITLAB_OAUTH_APP client row (`personalConnectionWhere`).
-- It already creates that row only under a per-person advisory lock after a
-- re-read; this index is the database backstop for a writer that does not
-- take the lock. The service retries a create that loses to it once, against
-- the row that won (`retryOnPersonalRowConflict`). The previous migration
-- (20261004120000_gitlab_mcp_config_drop_token_copies) removed the duplicates
-- that would stop it from building.
--
-- The predicate is the service's filter exactly. "name" is NOT NULL, so `<>`
-- is what Prisma's `NOT: { name: "GITLAB_OAUTH_APP" }` selects. Rows it leaves
-- out keep coexisting for the same person: a workflow-scoped GitLab row, the
-- GITLAB_OAUTH_APP client row, and every other provider's rows.
--
-- NULLS NOT DISTINCT so a row with no organization collides with another row
-- with no organization, as the service's `organizationId: null` filter treats
-- them as the same tenant. Postgres 15+; production and Aspire run 17, CI runs
-- 16 — the same modifier as 20260903100000_prompt_binding_unique_nulls_not_distinct.
--
-- Prisma models neither a partial index nor NULLS NOT DISTINCT, so the index
-- is owned here and documented on the WorkflowIntegration model, not declared
-- with @@unique (which would make every `migrate dev` try to recreate it).
--
-- NO `IF NOT EXISTS` — deliberately, and do not add it. A failed concurrent
-- build (a duplicate inserted between the previous migration's commit and this
-- build) leaves the index behind with `indisvalid = false`; `IF NOT EXISTS`
-- would then see the name taken on the retry and skip the rebuild, so the
-- migration would be recorded as applied while the uniqueness it promises
-- silently did not exist. Without the clause the retry fails loudly instead.
-- Recovery per docs/database-promotion.md § "A concurrent build that does
-- fail": find it with
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- then `DROP INDEX CONCURRENTLY "workflow_integration_personal_gitlab_key";`,
-- fold the new duplicate into its canonical row the way the previous migration
-- does, `prisma migrate resolve --rolled-back
-- 20261004120100_workflow_integration_personal_gitlab_unique`, and redeploy.
--
-- KEEP THIS MIGRATION TO ONE STATEMENT. A second one reintroduces Prisma's
-- transaction wrapper, and CONCURRENTLY cannot run inside a transaction
-- (SQLSTATE 25001).
CREATE UNIQUE INDEX CONCURRENTLY "workflow_integration_personal_gitlab_key"
  ON "workflow_integration" ("userId", "organizationId") NULLS NOT DISTINCT
  WHERE "provider" = 'GITLAB'
    AND "workflowId" IS NULL
    AND "name" <> 'GITLAB_OAUTH_APP';
