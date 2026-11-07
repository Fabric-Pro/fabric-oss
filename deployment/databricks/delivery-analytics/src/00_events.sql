-- Databricks notebook source
-- Collapse each event's CDC history BEFORE audience filtering or event-time ordering.
-- Never use occurred_at to resolve redaction, update or deletion order.
CREATE OR REPLACE VIEW {{DEST}}.delivery_events AS
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY id ORDER BY _sort_by DESC, _pg_lsn DESC,
        CASE _pg_change_type WHEN 'delete' THEN 3
          WHEN 'update_postimage' THEN 2 ELSE 1 END DESC
    ) AS change_rank,
    MAX(CASE WHEN _sort_by IS NULL OR _pg_lsn IS NULL THEN 1 ELSE 0 END)
      OVER (PARTITION BY id) AS unknown_order
  FROM {{SOURCE}}
  WHERE _pg_change_type IN ('insert', 'update_postimage', 'delete')
)
SELECT id, occurred_at, organization_id, project_id, subject_type, subject_id,
  event_type, from_state, to_state, schema_version
FROM ranked
WHERE change_rank = 1 AND unknown_order = 0 AND _pg_change_type <> 'delete'
  AND schema_version = 1
  AND subject_type IN ('story', 'coding_run')
  AND event_type IN ('created', 'stage_changed', 'status_changed')
  AND organization_id = {{ORGANIZATION}}
  AND project_id IN ({{PROJECTS}})
  AND session_user() = {{PRINCIPAL}};
