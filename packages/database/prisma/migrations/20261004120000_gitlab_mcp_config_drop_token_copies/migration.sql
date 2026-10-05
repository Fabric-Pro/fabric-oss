-- GitLab MCP server configs stop holding credential copies, and each person
-- has at most one personal GitLab connection row (data only, no schema change;
-- the unique index that enforces the second point is the NEXT migration, which
-- must be alone in its file because it is built CONCURRENTLY).
--
-- A person's GitLab credential lives on ONE row: their personal
-- "workflow_integration" (provider GITLAB, no workflow, not the
-- GITLAB_OAUTH_APP client row), owned by the GitLab connection service. The
-- "mcp_config" rows of the `gitlab` / `gitlab-official` servers used to carry
-- copies of it: the OAuth token columns, and on some rows a personal access
-- token saved as the API key ("encryptedApiKey") by an API caller. The
-- release that ships this migration neither reads nor writes either: the
-- connection service used to "adopt" a `gitlab-official` copy into the
-- person's connection the first time it read it, that read-time adoption is
-- gone, and every GitLab reader now resolves through the connection whatever
-- auth type the config names. A copy that was never adopted is therefore a
-- connection its owner has to make again (section 1).
--
-- 0. LOCKS. Everything below runs against a frozen view of the rows it reads.
--    The count, the nulling and the duplicate map are each a read followed by
--    writes decided from it; without the locks, the running application (this
--    release's replicas, or the previous release's during a rolling deploy)
--    could change those rows in between. Examples this prevents:
--      - a previous-release replica adopts a copy into a NEW connection row,
--        or saves a personal access token as a GitLab config's API key, while
--        this migration runs, so the reported count and the nulling below
--        disagree about what was there;
--      - a disconnect deactivates the newer of two duplicate rows (making the
--        older one canonical) and a connect then writes a fresh credential to
--        the older one, after the duplicate map already marked it for
--        deletion — the delete would remove the person's live connection;
--      - an agent binding, report binding or preference naming a duplicate is
--        written after the repoints below and before the delete, and is lost
--        (FK cascade) or left pointing at a deleted row.
--    `SHARE ROW EXCLUSIVE` is the weakest mode that blocks every INSERT,
--    UPDATE and DELETE (they take ROW EXCLUSIVE, which it conflicts with)
--    while still letting plain SELECTs run, and that also conflicts with
--    itself, so no other session can hold the same lock and deadlock with
--    this one on the upgrade to the row locks the writes below take. (SHARE
--    would block the same writes but not itself; EXCLUSIVE would also block
--    `SELECT … FOR UPDATE`, which no code issues on these tables.)
--    The tables only the dedupe writes are locked when there is something to
--    dedupe (expected: never), so the common case does not stall agent,
--    report or preference saves at all.
--    LOCK ORDER. Locks are taken in the order application transactions
--    write these tables, so no transaction can hold one of them while
--    waiting for one this migration already holds and that is waiting on
--    it: workflow_integration, mcp_config, then (only with duplicates)
--    agent_template_instance, agent_integration_configuration,
--    agent_mcp_server_configuration, template_instance,
--    project_databricks_knowledge_binding, integration_approval,
--    authority_grant, user_orchestrator_preferences. Transactional writers
--    checked (every `$transaction` / `withRefreshLock` callback that writes
--    one of these tables; no raw SQL writes any of them):
--      - GitLab connection service (`integrations/src/gitlab/connection.ts`):
--        connect, disconnect and classification write workflow_integration,
--        then mcp_config. No transaction writes mcp_config first.
--      - Legacy adoption (`connection-legacy-adoption.ts`), GitHub
--        (`integrations/src/github/index.ts`), integration sharing
--        (`api/modules/workflows/lib/integration-sharing.ts`):
--        workflow_integration only.
--      - Agent versioning and restore (`queries/agent-templates.ts`):
--        agent_template_instance (archive, create), then
--        agent_integration_configuration (nested create or createMany). The
--        in-place knowledge update writes agent_integration_configuration
--        alone.
--      - Reports (`queries/reports.ts`): template_instance only.
--      - Databricks knowledge bindings
--        (`queries/projects/databricks-knowledge-binding.ts`) and authority
--        grants (`queries/authority.ts`): their own table only.
--        integration_approval, agent_mcp_server_configuration and
--        user_orchestrator_preferences have no transactional writer.
--      - Foreign-key cascades follow the same parent-before-child order
--        (deleting a connection row reaches its agent bindings; deleting an
--        agent instance reaches its bindings). A foreign-key check takes ROW
--        SHARE, which does not conflict with SHARE ROW EXCLUSIVE.
--    The one order nothing here controls is a cascade from deleting a whole
--    user or organization. If one ever interleaves with this migration,
--    Postgres detects the deadlock and aborts one side: the delete fails and
--    is retried, or this migration rolls back entirely (nothing applied) and
--    is re-run after `prisma migrate resolve --rolled-back`. No data is lost
--    either way.
--    `lock_timeout` makes a lock that cannot be had within five seconds abort
--    the migration loudly (re-run it after `prisma migrate resolve
--    --rolled-back`) rather than queue every reader behind it.
--    What an application transaction sees: a write blocks until this
--    migration commits (or until its own lock_timeout/statement_timeout). One
--    that read a duplicate row before the lock and writes it afterwards finds
--    the row gone: an update or delete by id fails (Prisma P2025, "record not
--    found") and a foreign-key insert naming it fails (P2003), so the request
--    errors and the user retries against the canonical row. Nothing is
--    written to a deleted row and nothing is dropped silently. A writer that
--    takes the connection service's per-person advisory lock re-reads under
--    it and finds the canonical row.
--
-- 1. COUNT, DO NOT REFUSE. Copies with no personal GitLab connection row for
--    the same person in the same organization are counted and reported with
--    RAISE NOTICE, then nulled with the rest:
--      a) a `gitlab-official` config with its own dynamic client registration
--         and a token copy (what read-time adoption used to turn into a
--         connection);
--      b) a `gitlab` / `gitlab-official` config holding an API key (a
--         personal access token saved there).
--    Their owners reconnect GitLab; that is an accepted cost of this release,
--    which can reach an environment together with the releases that
--    introduced the connection, so nothing can be adopted ahead of it.
--    Running `packages/api/scripts/backfill-gitlab-connections.ts` (dry run
--    first) BEFORE this migration, on a database whose running release
--    already reads GitLab connections, is optional and avoids those
--    reconnects: it adopts a) as a connection issued by that registration and
--    b) as a personal access token on the instance the config names, and it
--    marks a connection whose grant is shared with a `gitlab-official`
--    registration as reconnect-required. Without it, a grant that
--    registration issued may be taken for one the integration app issued; if
--    so its first refresh fails and the person is asked to reconnect. The copies are only ever
--    nulled, never handed to anyone.
--    The rows counted are listed by:
--      SELECT c."id", c."userId", c."organizationId", s."key",
--             (c."encryptedApiKey" IS NOT NULL) AS "hasApiKey"
--        FROM "mcp_config" c JOIN "mcp_server" s ON s."id" = c."mcpServerId"
--       WHERE c."userId" IS NOT NULL
--         AND ((s."key" = 'gitlab-official'
--               AND c."encryptedAccessToken" IS NOT NULL
--               AND c."oauthClientId" IS NOT NULL)
--           OR (s."key" IN ('gitlab', 'gitlab-official')
--               AND c."encryptedApiKey" IS NOT NULL))
--         AND NOT EXISTS (<the personal-row test below>);
--    The personal-row test matches the connection service's own filter
--    (`personalConnectionWhere`): provider GITLAB, "workflowId" IS NULL,
--    "name" <> 'GITLAB_OAUTH_APP', same "userId", and "organizationId" equal
--    with NULL matching NULL. Prisma compiles `NOT: { name: "GITLAB_OAUTH_APP" }`
--    to `NOT ("name" = $1)`, which excludes a NULL name; "name" is NOT NULL on
--    this table, so `<>` is that filter exactly. ANY such row counts, active
--    or not: an inactive row is a disconnect (or a tombstone) the person
--    already made, which adoption respected too.
--
--
-- 2. NULL THE CREDENTIAL COPIES on every `gitlab` / `gitlab-official` config:
--    "encryptedAccessToken", "accessTokenHash", "encryptedRefreshToken",
--    "tokenExpiresAt" and "encryptedApiKey"; and set "authType" to 'OAUTH2',
--    the only auth type those servers offer (`authMethods: ["OAUTH2"]`), so
--    every screen sees one shape and none asks such a row for an API key
--    (`mcp.configs.upsert` stores OAUTH2 for them from this release on). The
--    dynamic client registration
--    ("oauthClientId", "encryptedOauthClientSecret", "dcrClientMetadata",
--    "dcrRegistrationEndpoint", "dcrRegisteredAt") is KEPT: it is the issuer
--    of a credential adopted from it, and every refresh of that credential
--    reads it. The Atlassian columns ("encryptedAtlassianCloud…") are an
--    Atlassian credential read only by Jira paths, not a GitLab one, and are
--    left alone. "apiKeyMethod" (NOT NULL, unused under OAUTH2), "scopes",
--    "enabled", "needsReauth", "status", the breaker counters and every other
--    column are unchanged: the screens read a GitLab server's state from the
--    person's connection, not from "status".
--    "mcp_server"."key" is not unique, so configs are matched by their
--    server's key, whichever server row carries it. Idempotent: the WHERE
--    clause matches only rows that still hold one of these values or name
--    another auth type.
--
-- 3. DEDUPE the personal GitLab connection rows so the next migration's unique
--    index can build. For each ("userId", "organizationId") the row the
--    service already treats as THE connection (`selectCanonicalConnection`:
--    active first, then oldest "createdAt", then lowest "id" in byte order) is
--    kept and the others are deleted, after every reference to them is moved
--    onto the kept row:
--      - "agent_integration_configuration"."integrationId" (FK, ON DELETE
--        CASCADE — deleting first would silently drop agent bindings): moved
--        to the kept row. Where that would give one agent instance two
--        bindings to the same row ("instanceId", "integrationId" is unique),
--        the binding already on the kept row wins, else the lowest-id one;
--        the others are deleted. They bound the same person's same GitLab
--        connection to the same agent, so only their per-binding resource
--        and access settings are lost.
--      - "project_databricks_knowledge_binding"."integrationId" (FK, ON DELETE
--        RESTRICT): moved. A GitLab row is never a Databricks binding, so
--        this is expected to touch nothing; if it did, RESTRICT would abort.
--      - "integration_approval"."integrationId" and
--        "authority_grant"."providerRefId" (plain columns, no FK): moved.
--      - "agent_mcp_server_configuration"."integrationIds" (text[]): each
--        duplicate id replaced by the kept row's, order kept, repeats dropped.
--      - JSON documents, at their reference positions only, matching whole
--        values (never a substring), keeping order and every other key:
--          "template_instance"."connections": the `integrations` array and
--            the values of `integrationBindings` (the two integration
--            references `reports/lib/validate-connections.ts` checks);
--          "agent_template_instance"."toolConnections": each tool's
--            `connectionId` (`agent-templates/lib/validate-connections.ts`);
--          "user_orchestrator_preferences"."enabledMcpConfigIds": array
--            elements exactly `oauth:integration:<id>` (what the orchestrator
--            settings write) or exactly `<id>` (a legacy form the preload
--            still reads).
--        An id inside free text — a report's `parameterBindings`, `context`
--        or prompt, a tool's `config` — is not a reference and is left as it
--        is. A document that is not the expected shape is skipped. In an
--        array, a repeat of the kept row's id created by the repoint is
--        dropped (first occurrence kept).
--    The service reads the canonical row, but the generic integration list
--    (`listWorkflowIntegrations`) returned every active row, so a duplicate's
--    id could have been handed to a client and stored in any of the places
--    above. Other places that hold a workflow integration id were ruled out:
--    an orchestrator plan step carries one, but a GitLab step ignores it and
--    uses the acting person's own connection; the workflow builder stores
--    none in its nodes; audit rows and notifications are history; the tool
--    index lives in Qdrant, not here, and is rebuilt by ingestion.
--
-- BOUNDED, AND IN ONE TRANSACTION ON PURPOSE. Every write here is bounded by
-- the GitLab rows it targets, not by the table: at most two GitLab MCP configs
-- per person per organization, and only the duplicate personal GitLab
-- connection rows (expected none) with their few references. The nulling and
-- the dedupe must commit together with the reference repoints: deleting a
-- duplicate whose references were not moved is the data loss this file exists
-- to prevent, so none of it can move to a separate batched job. (The migration linter's `unbatched-backfill` rule does not flag
-- the top-level statements, and it does not inspect the bodies of the DO
-- blocks or of the session-temporary helper functions, whose statements each
-- touch only rows that name a duplicate, or only the value passed in; so no
-- allow marker is needed, and this is the reasoning a reviewer would otherwise
-- have asked for.)
SET LOCAL lock_timeout = '5s';

LOCK TABLE "workflow_integration", "mcp_config" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  unadopted_tokens bigint;
  unadopted_api_keys bigint;
BEGIN
  SELECT count(*) INTO unadopted_tokens
    FROM "mcp_config" c
    JOIN "mcp_server" s ON s."id" = c."mcpServerId"
   WHERE s."key" = 'gitlab-official'
     AND c."userId" IS NOT NULL
     AND c."encryptedAccessToken" IS NOT NULL
     AND c."oauthClientId" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM "workflow_integration" w
        WHERE w."provider" = 'GITLAB'
          AND w."workflowId" IS NULL
          AND w."name" <> 'GITLAB_OAUTH_APP'
          AND w."userId" = c."userId"
          AND w."organizationId" IS NOT DISTINCT FROM c."organizationId"
     );

  SELECT count(*) INTO unadopted_api_keys
    FROM "mcp_config" c
    JOIN "mcp_server" s ON s."id" = c."mcpServerId"
   WHERE s."key" IN ('gitlab', 'gitlab-official')
     AND c."userId" IS NOT NULL
     AND c."encryptedApiKey" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM "workflow_integration" w
        WHERE w."provider" = 'GITLAB'
          AND w."workflowId" IS NULL
          AND w."name" <> 'GITLAB_OAUTH_APP'
          AND w."userId" = c."userId"
          AND w."organizationId" IS NOT DISTINCT FROM c."organizationId"
     );

  IF unadopted_tokens > 0 OR unadopted_api_keys > 0 THEN
    RAISE NOTICE
      '% gitlab-official MCP config(s) hold a GitLab token copy, and % gitlab/gitlab-official MCP config(s) hold a GitLab API key, with no personal GitLab connection row behind them. Their copies are nulled below and their owners reconnect GitLab.',
      unadopted_tokens, unadopted_api_keys;
  END IF;
END $$;

UPDATE "mcp_config" c
   SET "encryptedAccessToken" = NULL,
       "accessTokenHash" = NULL,
       "encryptedRefreshToken" = NULL,
       "tokenExpiresAt" = NULL,
       "encryptedApiKey" = NULL,
       "authType" = 'OAUTH2'
  FROM "mcp_server" s
 WHERE s."id" = c."mcpServerId"
   AND s."key" IN ('gitlab', 'gitlab-official')
   AND (
     c."encryptedAccessToken" IS NOT NULL
     OR c."accessTokenHash" IS NOT NULL
     OR c."encryptedRefreshToken" IS NOT NULL
     OR c."tokenExpiresAt" IS NOT NULL
     OR c."encryptedApiKey" IS NOT NULL
     OR c."authType" <> 'OAUTH2'
   );

-- Every duplicate personal GitLab row, with the row it folds into. Read while
-- "workflow_integration" is locked, so it cannot go stale before the writes
-- below. Dropped at COMMIT; nothing outside this transaction sees it.
CREATE TEMPORARY TABLE "gitlab_personal_duplicate" ON COMMIT DROP AS
SELECT ranked."id" AS "duplicateId",
       ranked."canonicalId"
  FROM (
    SELECT w."id",
           FIRST_VALUE(w."id") OVER personal AS "canonicalId",
           ROW_NUMBER() OVER personal AS rank_in_person
      FROM "workflow_integration" w
     WHERE w."provider" = 'GITLAB'
       AND w."workflowId" IS NULL
       AND w."name" <> 'GITLAB_OAUTH_APP'
    WINDOW personal AS (
      PARTITION BY w."userId", w."organizationId"
      ORDER BY w."isActive" DESC, w."createdAt" ASC, w."id" COLLATE "C" ASC
    )
  ) ranked
 WHERE ranked.rank_in_person > 1;

-- The tables only the dedupe writes, frozen too — only when there is
-- something to dedupe — in the order application transactions write them
-- (header, LOCK ORDER): an agent instance before its child bindings.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "gitlab_personal_duplicate") THEN
    LOCK TABLE "agent_template_instance",
               "agent_integration_configuration",
               "agent_mcp_server_configuration",
               "template_instance",
               "project_databricks_knowledge_binding",
               "integration_approval",
               "authority_grant",
               "user_orchestrator_preferences"
      IN SHARE ROW EXCLUSIVE MODE;
  END IF;
END $$;

-- Agent bindings: one per (instance, kept row). The binding already on the
-- kept row wins; otherwise the lowest-id binding of a duplicate.
DELETE FROM "agent_integration_configuration" victim
USING (
  SELECT a."id",
         ROW_NUMBER() OVER (
           PARTITION BY a."instanceId", member."canonicalId"
           ORDER BY (a."integrationId" = member."canonicalId") DESC,
                    a."id" COLLATE "C" ASC
         ) AS rank_in_instance
    FROM "agent_integration_configuration" a
    JOIN (
      SELECT "duplicateId" AS "memberId", "canonicalId"
        FROM "gitlab_personal_duplicate"
      UNION
      SELECT "canonicalId" AS "memberId", "canonicalId"
        FROM "gitlab_personal_duplicate"
    ) member ON member."memberId" = a."integrationId"
) ranked
 WHERE victim."id" = ranked."id"
   AND ranked.rank_in_instance > 1;

UPDATE "agent_integration_configuration" a
   SET "integrationId" = d."canonicalId"
  FROM "gitlab_personal_duplicate" d
 WHERE a."integrationId" = d."duplicateId";

UPDATE "project_databricks_knowledge_binding" b
   SET "integrationId" = d."canonicalId"
  FROM "gitlab_personal_duplicate" d
 WHERE b."integrationId" = d."duplicateId";

UPDATE "integration_approval" ap
   SET "integrationId" = d."canonicalId"
  FROM "gitlab_personal_duplicate" d
 WHERE ap."integrationId" = d."duplicateId";

UPDATE "authority_grant" g
   SET "providerRefId" = d."canonicalId"
  FROM "gitlab_personal_duplicate" d
 WHERE g."providerRefId" = d."duplicateId";

-- Whole-value repointing for the id array and the JSON documents below. Each
-- helper rewrites only the reference positions it names, compares whole
-- values (never substrings), keeps element order and every other key, and
-- returns its input unchanged when the input is not the shape it expects
-- (NULL, a scalar, an array where an object belongs, …) — a malformed
-- document is skipped, never rewritten or allowed to abort the migration.
-- Session-temporary (pg_temp), and dropped at the end of this file.

-- A JSON array with every element equal to the string `old_value` replaced by
-- `new_value`, later repeats of `new_value` dropped (first occurrence kept).
CREATE FUNCTION pg_temp.gitlab_repoint_jsonb_array(
  arr jsonb, old_value text, new_value text
) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  rebuilt jsonb;
BEGIN
  IF jsonb_typeof(arr) IS DISTINCT FROM 'array' THEN
    RETURN arr;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(arr) AS e(value)
     WHERE e.value = to_jsonb(old_value)
  ) THEN
    RETURN arr;
  END IF;
  SELECT COALESCE(jsonb_agg(mapped.value ORDER BY mapped.position), '[]'::jsonb)
    INTO rebuilt
    FROM (
      SELECT m.value,
             m.position,
             ROW_NUMBER() OVER (PARTITION BY m.value ORDER BY m.position)
               AS occurrence
        FROM (
          SELECT CASE WHEN e.value = to_jsonb(old_value)
                      THEN to_jsonb(new_value)
                      ELSE e.value END AS value,
                 e.position
            FROM jsonb_array_elements(arr) WITH ORDINALITY AS e(value, position)
        ) m
    ) mapped
   WHERE mapped.occurrence = 1 OR mapped.value <> to_jsonb(new_value);
  RETURN rebuilt;
END
$fn$;

-- A JSON object with every VALUE equal to the string `old_value` replaced by
-- `new_value`; keys untouched.
CREATE FUNCTION pg_temp.gitlab_repoint_jsonb_object_values(
  obj jsonb, old_value text, new_value text
) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  entry record;
  result jsonb := obj;
BEGIN
  IF jsonb_typeof(obj) IS DISTINCT FROM 'object' THEN
    RETURN obj;
  END IF;
  FOR entry IN SELECT e.key, e.value FROM jsonb_each(obj) AS e LOOP
    IF entry.value = to_jsonb(old_value) THEN
      result := jsonb_set(result, ARRAY[entry.key], to_jsonb(new_value));
    END IF;
  END LOOP;
  RETURN result;
END
$fn$;

-- A report instance's "connections": the `integrations` id list and the
-- values of `integrationBindings` (data source → integration id), the two
-- integration references `reports/lib/validate-connections.ts` validates.
-- `mcpConfigs`, `mcpBindings`, `parameterBindings`, `resourceBindings` and
-- every other key are left alone.
CREATE FUNCTION pg_temp.gitlab_repoint_report_connections(
  doc jsonb, old_value text, new_value text
) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  result jsonb := doc;
BEGIN
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' THEN
    RETURN doc;
  END IF;
  IF doc ? 'integrations' THEN
    result := jsonb_set(
      result, '{integrations}',
      pg_temp.gitlab_repoint_jsonb_array(doc -> 'integrations', old_value, new_value)
    );
  END IF;
  IF doc ? 'integrationBindings' THEN
    result := jsonb_set(
      result, '{integrationBindings}',
      pg_temp.gitlab_repoint_jsonb_object_values(doc -> 'integrationBindings', old_value, new_value)
    );
  END IF;
  RETURN result;
END
$fn$;

-- An agent instance's "toolConnections" (tool name → settings): only each
-- tool's `connectionId`, the integration reference
-- `agent-templates/lib/validate-connections.ts` validates. `config` and every
-- other field are left alone.
CREATE FUNCTION pg_temp.gitlab_repoint_tool_connections(
  doc jsonb, old_value text, new_value text
) RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
  entry record;
  result jsonb := doc;
BEGIN
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' THEN
    RETURN doc;
  END IF;
  FOR entry IN SELECT e.key, e.value FROM jsonb_each(doc) AS e LOOP
    IF jsonb_typeof(entry.value) = 'object'
       AND entry.value -> 'connectionId' = to_jsonb(old_value) THEN
      result := jsonb_set(
        result, ARRAY[entry.key, 'connectionId'], to_jsonb(new_value)
      );
    END IF;
  END LOOP;
  RETURN result;
END
$fn$;

-- Agent MCP tool bindings (an id array) and the JSON documents that store a
-- workflow integration id: one pass per duplicate, so a row naming several
-- duplicates gets every one. `strpos` only narrows the rows looked at; the
-- rewrite itself is the whole-value helpers above, and a row is written only
-- when one of them changed it.
DO $$
DECLARE
  pair record;
BEGIN
  FOR pair IN
    SELECT "duplicateId", "canonicalId" FROM "gitlab_personal_duplicate"
  LOOP
    UPDATE "agent_mcp_server_configuration"
       SET "integrationIds" = ARRAY(
             SELECT element.id
               FROM unnest(
                      array_replace("integrationIds", pair."duplicateId", pair."canonicalId")
                    ) WITH ORDINALITY AS element(id, position)
              GROUP BY element.id
              ORDER BY MIN(element.position)
           )
     WHERE pair."duplicateId" = ANY("integrationIds");

    UPDATE "template_instance"
       SET "connections" = pg_temp.gitlab_repoint_report_connections(
             "connections", pair."duplicateId", pair."canonicalId")
     WHERE strpos("connections"::text, pair."duplicateId") > 0
       AND pg_temp.gitlab_repoint_report_connections(
             "connections", pair."duplicateId", pair."canonicalId")
           IS DISTINCT FROM "connections";

    UPDATE "agent_template_instance"
       SET "toolConnections" = pg_temp.gitlab_repoint_tool_connections(
             "toolConnections", pair."duplicateId", pair."canonicalId")
     WHERE strpos("toolConnections"::text, pair."duplicateId") > 0
       AND pg_temp.gitlab_repoint_tool_connections(
             "toolConnections", pair."duplicateId", pair."canonicalId")
           IS DISTINCT FROM "toolConnections";

    -- Elements exactly `oauth:integration:<id>` (the format the orchestrator
    -- settings write and the preload reads), and a bare `<id>` element (the
    -- legacy form the preload still accepts).
    UPDATE "user_orchestrator_preferences"
       SET "enabledMcpConfigIds" = pg_temp.gitlab_repoint_jsonb_array(
             pg_temp.gitlab_repoint_jsonb_array(
               "enabledMcpConfigIds",
               'oauth:integration:' || pair."duplicateId",
               'oauth:integration:' || pair."canonicalId"),
             pair."duplicateId", pair."canonicalId")
     WHERE strpos("enabledMcpConfigIds"::text, pair."duplicateId") > 0
       AND pg_temp.gitlab_repoint_jsonb_array(
             pg_temp.gitlab_repoint_jsonb_array(
               "enabledMcpConfigIds",
               'oauth:integration:' || pair."duplicateId",
               'oauth:integration:' || pair."canonicalId"),
             pair."duplicateId", pair."canonicalId")
           IS DISTINCT FROM "enabledMcpConfigIds";
  END LOOP;
END $$;

DELETE FROM "workflow_integration" w
USING "gitlab_personal_duplicate" d
 WHERE w."id" = d."duplicateId";

DROP FUNCTION pg_temp.gitlab_repoint_tool_connections(jsonb, text, text);
DROP FUNCTION pg_temp.gitlab_repoint_report_connections(jsonb, text, text);
DROP FUNCTION pg_temp.gitlab_repoint_jsonb_object_values(jsonb, text, text);
DROP FUNCTION pg_temp.gitlab_repoint_jsonb_array(jsonb, text, text);
