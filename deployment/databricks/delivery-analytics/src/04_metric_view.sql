-- Databricks notebook source
CREATE OR REPLACE VIEW {{DEST}}.delivery_metrics
WITH METRICS LANGUAGE YAML AS $$
version: "1.1"
comment: Bounded delivery metadata; first retained captured transitions, not deployment outcomes or complete lifetime coverage.
source: {{DEST_PLAIN}}.delivery_daily
fields:
  - name: Day
    expr: day
    comment: UTC calendar day of the retained recorded event.
    synonyms: [Event day, Delivery day]
  - name: Organization ID
    expr: organization_id
    comment: Fixed organization selected by the operator-owned audience binding.
    synonyms: [Organization]
  - name: Project ID
    expr: project_id
    comment: Project in the fixed operator-approved allowlist.
    synonyms: [Project]
measures:
  - name: Features Created
    expr: SUM(created_count)
    comment: One first retained created event per story; excludes coding runs.
    synonyms: [Stories created, Created scope]
  - name: Features Ready for Development
    expr: SUM(ready_count)
    comment: One first retained stage_changed to PUBLISHED per story; does not mean deployed, released, merged or completed.
    synonyms: [Stories ready for development, Ready scope]
  - name: Coding Runs Created
    expr: SUM(run_count)
    comment: One first retained created event per coding run; does not imply success.
    synonyms: [Runs created]
$$;
