-- Spec: fabric/specs/2026-05-19-remove-passive-analysis/spec.md
-- Per OQ-1 default: this migration is data-only; the FeatureDraftingStage
-- enum keeps PASSIVE_ANALYSIS for historical-row safety and MCP public-API
-- backward compatibility.
--
-- Defensive sweep across all 4 tables that bear the FeatureDraftingStage
-- enum. Pre-flight (REQ-PRE-2) is expected to show ~250 rows in user_story
-- and 0 in the rest; the sweep is a safety net so we don't have to retry if
-- a row sneaks in between snapshot and apply.
--
-- Locking analysis: each statement is a row-level UPDATE bounded by the
-- WHERE clause. Postgres acquires ROW EXCLUSIVE on the table (not ACCESS
-- EXCLUSIVE), so concurrent SELECTs and FK lookups proceed. At ~250 rows
-- total across 4 tables, no batching is needed. This satisfies NFR-1.

UPDATE "user_story"     SET "draftingStage" = 'PLACEHOLDER' WHERE "draftingStage" = 'PASSIVE_ANALYSIS';
UPDATE "feature_version" SET "draftingStage" = 'PLACEHOLDER' WHERE "draftingStage" = 'PASSIVE_ANALYSIS';
UPDATE "epic"           SET "draftingStage" = 'PLACEHOLDER' WHERE "draftingStage" = 'PASSIVE_ANALYSIS';
UPDATE "feature"        SET "draftingStage" = 'PLACEHOLDER' WHERE "draftingStage" = 'PASSIVE_ANALYSIS';

-- Rollback procedure (per spec §5.4):
-- The migration cannot be perfectly reversed by inverse SQL — once a row's
-- draftingStage is set to PLACEHOLDER, the database has no way to distinguish
-- "ex-PASSIVE_ANALYSIS" rows from "always-PLACEHOLDER" rows. Rollback is
-- defined as restoring by snapshot, NOT by reverse-migration.
--
-- The snapshot file `passive_analysis_snapshot_<deploy>.sql` is captured by
-- the pre-deploy gate REQ-PRE-2 and attached to the deploy ticket. To roll
-- back, run (replacing the placeholder ID list with the snapshot contents):
--
--   UPDATE "user_story"      SET "draftingStage" = 'PASSIVE_ANALYSIS' WHERE id IN (<snapshot user_story IDs>);
--   UPDATE "feature_version" SET "draftingStage" = 'PASSIVE_ANALYSIS' WHERE id IN (<snapshot feature_version IDs>);
--   UPDATE "epic"            SET "draftingStage" = 'PASSIVE_ANALYSIS' WHERE id IN (<snapshot epic IDs>);
--   UPDATE "feature"         SET "draftingStage" = 'PASSIVE_ANALYSIS' WHERE id IN (<snapshot feature IDs>);
--
-- Then revert the application code via `git revert <commit>` + redeploy.
-- The Prisma enum keeps PASSIVE_ANALYSIS so the rolled-back code reads
-- restored rows correctly. Rollback path is tested in staging before
-- production deploy (per release plan §13).
