-- Per-user, per-project warning suppression for dependency-aware capability
-- gating (Fizzy #1930).
--
-- Additive and nullable: every existing row keeps meaning "nothing suppressed",
-- so there is no backfill and nothing to roll back beyond dropping the column.
-- No index — the column is only ever read through the row's existing
-- (projectId, userId) unique key, never searched across.
ALTER TABLE "project_user_preference"
  ADD COLUMN "capabilityWarningSuppressions" JSONB;
