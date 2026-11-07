-- Databricks notebook source
CREATE OR REPLACE VIEW {{DEST}}.delivery_current AS
WITH ranked AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY organization_id, project_id, subject_type, subject_id
    ORDER BY occurred_at DESC, id DESC
  ) AS subject_rank
  FROM {{DEST}}.delivery_events
)
SELECT organization_id, project_id, subject_type, subject_id,
  to_state AS current_state, from_state, occurred_at AS last_event_at,
  event_type AS last_event_type
FROM ranked WHERE subject_rank = 1;
