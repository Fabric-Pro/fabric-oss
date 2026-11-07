-- Databricks notebook source
-- Explicit operator run only. No source grants, group grants or account grants.
GRANT USE CATALOG ON CATALOG {{DEST_CATALOG}} TO {{PRINCIPAL_IDENTIFIER}};
-- COMMAND ----------
GRANT USE SCHEMA ON SCHEMA {{DEST}} TO {{PRINCIPAL_IDENTIFIER}};
-- COMMAND ----------
GRANT SELECT ON TABLE {{DEST}}.delivery_current TO {{PRINCIPAL_IDENTIFIER}};
-- COMMAND ----------
GRANT SELECT ON TABLE {{DEST}}.delivery_daily TO {{PRINCIPAL_IDENTIFIER}};
-- COMMAND ----------
GRANT SELECT ON TABLE {{DEST}}.delivery_ready_durations TO {{PRINCIPAL_IDENTIFIER}};
-- COMMAND ----------
GRANT SELECT ON TABLE {{DEST}}.delivery_metrics TO {{PRINCIPAL_IDENTIFIER}};
