-- Databricks notebook source
USE CATALOG IDENTIFIER(:catalog);

-- COMMAND ----------
USE SCHEMA IDENTIFIER(:schema);

-- COMMAND ----------
-- A re-snapshot REPLACES the history table: all rows visible to this statement
-- belong to its current generation. Never retain offsets, union old snapshots,
-- filter by max(_pg_xid), or use occurred_at (the event time survives redaction).
-- Ignore preimages BEFORE ranking; they may share an offset with the postimage.
CREATE OR REPLACE TABLE decision_event_current USING DELTA AS
WITH ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY id ORDER BY _sort_by DESC, _pg_lsn DESC,
      CASE _pg_change_type WHEN 'delete' THEN 3 WHEN 'update_postimage' THEN 2 ELSE 1 END DESC
  ) AS change_rank
  FROM lb_decision_event_history
  WHERE _pg_change_type IN ('insert', 'update_postimage', 'delete')
)
SELECT id, occurred_at, organization_id, project_id, subject_type, subject_id,
  event_type, from_state, to_state, actor_kind, actor_id, related_subject_id,
  feature_key, model, prompt_version_id, payload, schema_version
FROM ranked
WHERE change_rank = 1 AND _pg_change_type <> 'delete';
