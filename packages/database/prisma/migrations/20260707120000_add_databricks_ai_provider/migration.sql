-- Databricks as an AI provider (BYOK) — Databricks Model Serving / Mosaic AI Gateway.
--
-- Schema delta:
--   * AIProvider += DATABRICKS (additive — existing consumers ignore unknown
--     enum values). An OpenAI-compatible, per-workspace serving surface
--     (https://<workspace-host>/serving-endpoints) configured per-tenant with a
--     workspace URL (config.baseUrl) + PAT (encrypted_api_key), analogous to
--     AZURE_AI_FOUNDRY.

-- AlterEnum
-- `IF NOT EXISTS` keeps the ADD VALUE idempotent across half-applied deploys.
ALTER TYPE "AIProvider" ADD VALUE IF NOT EXISTS 'DATABRICKS';
