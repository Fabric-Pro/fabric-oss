-- Databricks notebook source
USE CATALOG IDENTIFIER(:catalog);

-- COMMAND ----------
USE SCHEMA IDENTIFIER(:schema);

-- COMMAND ----------
-- Backtick-escape the application id as one principal, never as SQL syntax.
DECLARE OR REPLACE VARIABLE grant_sql STRING;

-- COMMAND ----------
SET VAR grant_sql = concat('GRANT SELECT ON TABLE suggestion_journey TO `', replace(:embed_principal, '`', '``'), '`');

-- COMMAND ----------
EXECUTE IMMEDIATE grant_sql;

-- COMMAND ----------
SET VAR grant_sql = concat('GRANT SELECT ON TABLE project_decision_daily TO `', replace(:embed_principal, '`', '``'), '`');

-- COMMAND ----------
EXECUTE IMMEDIATE grant_sql;

-- COMMAND ----------
SET VAR grant_sql = concat('GRANT SELECT ON TABLE needs_review TO `', replace(:embed_principal, '`', '``'), '`');

-- COMMAND ----------
EXECUTE IMMEDIATE grant_sql;

-- COMMAND ----------
SET VAR grant_sql = concat('GRANT SELECT ON TABLE duplicate_outcomes TO `', replace(:embed_principal, '`', '``'), '`');

-- COMMAND ----------
EXECUTE IMMEDIATE grant_sql;

-- COMMAND ----------
SET VAR grant_sql = concat('GRANT SELECT ON TABLE rating_outcomes TO `', replace(:embed_principal, '`', '``'), '`');

-- COMMAND ----------
EXECUTE IMMEDIATE grant_sql;

-- COMMAND ----------
SET VAR grant_sql = concat('GRANT SELECT ON TABLE change_outcomes TO `', replace(:embed_principal, '`', '``'), '`');

-- COMMAND ----------
EXECUTE IMMEDIATE grant_sql;
