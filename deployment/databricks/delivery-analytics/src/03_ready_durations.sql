-- Databricks notebook source
CREATE OR REPLACE VIEW {{DEST}}.delivery_ready_durations AS
SELECT organization_id, project_id, subject_id, created_at, ready_at,
  CASE WHEN created_at IS NOT NULL AND ready_at >= created_at
    THEN (UNIX_TIMESTAMP(ready_at) - UNIX_TIMESTAMP(created_at)) / 86400.0
    ELSE NULL END AS ready_days,
  CASE WHEN created_at IS NULL THEN 'CREATION_NOT_CAPTURED'
    WHEN ready_at < created_at THEN 'INCONSISTENT_EVENT_TIMES'
    ELSE 'RECORDED_INTERVAL' END AS duration_coverage
FROM {{DEST}}.delivery_facts
WHERE subject_type = 'story' AND ready_at IS NOT NULL;
