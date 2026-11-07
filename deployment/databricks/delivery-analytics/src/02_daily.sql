-- Databricks notebook source
SET TIME ZONE 'UTC';
-- COMMAND ----------
CREATE OR REPLACE VIEW {{DEST}}.delivery_daily AS
WITH facts AS (
  SELECT organization_id, project_id, DATE(created_at) AS day,
    CASE WHEN subject_type = 'story' THEN 1 ELSE 0 END AS created_count,
    0 AS ready_count,
    CASE WHEN subject_type = 'coding_run' THEN 1 ELSE 0 END AS run_count
  FROM {{DEST}}.delivery_facts WHERE created_at IS NOT NULL
  UNION ALL
  SELECT organization_id, project_id, DATE(ready_at) AS day,
    0 AS created_count, 1 AS ready_count, 0 AS run_count
  FROM {{DEST}}.delivery_facts WHERE ready_at IS NOT NULL
)
SELECT organization_id, project_id, day,
  SUM(created_count) AS created_count, SUM(ready_count) AS ready_count,
  SUM(run_count) AS run_count
FROM facts GROUP BY organization_id, project_id, day;
