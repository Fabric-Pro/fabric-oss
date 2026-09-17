-- Unique index for project.publishedInstructionSnapshotId (Coding Instructions).
--
-- Alone in its own migration and CONCURRENTLY: a CREATE INDEX on an existing
-- table is rejected by the migration linter otherwise, and a concurrent build
-- cannot run inside a transaction block.
--
-- Enforces that a snapshot is published by at most one project. NULLs do not
-- collide, so every pre-existing row (every project has a NULL pointer today)
-- is unaffected.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "project_publishedInstructionSnapshotId_key"
  ON "project" ("publishedInstructionSnapshotId");
