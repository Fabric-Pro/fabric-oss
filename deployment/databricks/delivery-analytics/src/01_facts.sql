-- Databricks notebook source
-- One creation and one first retained PUBLISHED transition per subject.
-- This is capture coverage, not a claim about the subject's whole lifetime.
CREATE OR REPLACE VIEW {{DEST}}.delivery_facts AS
SELECT organization_id, project_id, subject_type, subject_id,
  MIN(CASE WHEN event_type = 'created' THEN occurred_at END) AS created_at,
  MIN(CASE WHEN subject_type = 'story' AND event_type = 'stage_changed'
    AND to_state = 'PUBLISHED' THEN occurred_at END) AS ready_at
FROM {{DEST}}.delivery_events
GROUP BY organization_id, project_id, subject_type, subject_id;
