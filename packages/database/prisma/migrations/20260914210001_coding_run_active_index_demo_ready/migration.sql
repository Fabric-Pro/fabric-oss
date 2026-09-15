-- Separate migration: Postgres refuses to use a value added by ALTER TYPE ...
-- ADD VALUE inside the same transaction (55P04), and the previous migration
-- added DEMO_READY to "CodingRunStatus".

-- One active coding run per story now also counts DEMO_READY (a spike awaiting
-- a human decision) as active, so a second spike or an implement run cannot
-- start until it is accepted or discarded.
-- migration-lint: allow blocking-index — the DROP and the CREATE UNIQUE below
-- must be one transaction (a window without the index would let two active runs
-- start), so CONCURRENTLY is not available. The index is PARTIAL over the active
-- statuses only (a handful of rows per project), so both the drop and the
-- rebuild are short; precedent 20260816140000 for the unique-build reasoning.
DROP INDEX IF EXISTS "coding_run_one_active_per_story";
CREATE UNIQUE INDEX "coding_run_one_active_per_story"
  ON "coding_run" ("storyId")
  WHERE "status" IN ('QUEUED','STARTING','RUNNING','AWAITING_REVIEW','PR_OPENED','DEMO_READY');
