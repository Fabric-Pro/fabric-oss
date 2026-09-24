-- Unique index for project_instruction_snapshot."syncRunKey" (repository sync).
--
-- Alone in its own migration and CONCURRENTLY: a CREATE INDEX on an existing
-- table is rejected by the migration linter otherwise, and a concurrent build
-- cannot run inside a transaction block.
--
-- Enforces one snapshot per logical sync acquisition. NULLs do not collide,
-- so every existing row (all NULL) is unaffected.
--
-- NO `IF NOT EXISTS`: a failed concurrent build leaves an invalid index behind
-- under this name, and the clause would then skip the rebuild and record the
-- migration as applied with no uniqueness enforced. Recovery per
-- docs/database-promotion.md: find it with
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- then DROP INDEX that name before re-running the migration.
CREATE UNIQUE INDEX CONCURRENTLY "project_instruction_snapshot_syncRunKey_key"
  ON "project_instruction_snapshot" ("syncRunKey");
