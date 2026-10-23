-- migration-lint: allow unbatched-backfill — The one-time freeze must commit with the columns before template seeding; lock and statement timeouts bound the backfill.
-- Schema and data share a migration so the new code sees pinned connections.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE "cloud_provider_config" ADD COLUMN "task_defaults_snapshot" JSONB;
ALTER TABLE "user_cloud_provider_config" ADD COLUMN "task_defaults_snapshot" JSONB;

-- The migration owner may lack BYPASSRLS on managed Postgres. These policies
-- grant it access for this backfill, including under FORCE RLS, and are removed
-- before commit. Other sessions cannot observe the temporary policies.
CREATE POLICY pin_task_defaults_backfill ON "cloud_provider_config"
  FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY pin_task_defaults_backfill ON "user_cloud_provider_config"
  FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

UPDATE "cloud_provider_config" AS connection
SET "task_defaults_snapshot" = jsonb_build_object(
  'version', 1,
  'capturedAt', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'scoped', (
    SELECT jsonb_object_agg(task.task_type, (
      SELECT model."canonicalName"
      FROM "ai_task_model_default" AS template
      JOIN "ai_model" AS model ON model.id = template."modelId"
      WHERE template.complexity = 'MEDIUM'
        AND template."taskType"::text = task.task_type
        AND template.provider = connection.provider
      ORDER BY template.priority DESC, template.id ASC
      LIMIT 1
    ))
    FROM (VALUES ('SIMPLE'), ('COMPLEX'), ('REASONING'), ('CHAT'), ('TOOL_CALLING'), ('EVAL')) AS task(task_type)
  ),
  'unscoped', (
    SELECT jsonb_object_agg(task.task_type, (
      SELECT model."canonicalName"
      FROM "ai_task_model_default" AS template
      JOIN "ai_model" AS model ON model.id = template."modelId"
      WHERE template.complexity = 'MEDIUM'
        AND template."taskType"::text = task.task_type
      ORDER BY template.priority DESC, template.id ASC
      LIMIT 1
    ))
    FROM (VALUES ('SIMPLE'), ('COMPLEX'), ('REASONING'), ('CHAT'), ('TOOL_CALLING'), ('EVAL')) AS task(task_type)
  )
);

UPDATE "user_cloud_provider_config" AS connection
SET "task_defaults_snapshot" = jsonb_build_object(
  'version', 1,
  'capturedAt', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'scoped', (
    SELECT jsonb_object_agg(task.task_type, (
      SELECT model."canonicalName"
      FROM "ai_task_model_default" AS template
      JOIN "ai_model" AS model ON model.id = template."modelId"
      WHERE template.complexity = 'MEDIUM'
        AND template."taskType"::text = task.task_type
        AND template.provider = connection.provider
      ORDER BY template.priority DESC, template.id ASC
      LIMIT 1
    ))
    FROM (VALUES ('SIMPLE'), ('COMPLEX'), ('REASONING'), ('CHAT'), ('TOOL_CALLING'), ('EVAL')) AS task(task_type)
  ),
  'unscoped', (
    SELECT jsonb_object_agg(task.task_type, (
      SELECT model."canonicalName"
      FROM "ai_task_model_default" AS template
      JOIN "ai_model" AS model ON model.id = template."modelId"
      WHERE template.complexity = 'MEDIUM'
        AND template."taskType"::text = task.task_type
      ORDER BY template.priority DESC, template.id ASC
      LIMIT 1
    ))
    FROM (VALUES ('SIMPLE'), ('COMPLEX'), ('REASONING'), ('CHAT'), ('TOOL_CALLING'), ('EVAL')) AS task(task_type)
  )
);

DROP POLICY pin_task_defaults_backfill ON "cloud_provider_config";
DROP POLICY pin_task_defaults_backfill ON "user_cloud_provider_config";
COMMIT;
