-- Unique index for decision_log_entry."supersedesId" (#1910).
--
-- Alone in its own migration and CONCURRENTLY: a CREATE INDEX on an existing
-- table is rejected by the migration linter otherwise, and a concurrent build
-- cannot run inside a transaction block.
--
-- Uniqueness enforces that a given answer turn is superseded at most once. A
-- second amendment supersedes the FIRST AMENDMENT, not the original, so the
-- chain stays linear. NULLs do not collide, so every pre-existing row is
-- unaffected.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "decision_log_entry_supersedesId_key"
  ON "decision_log_entry" ("supersedesId");
