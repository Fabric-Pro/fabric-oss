-- Inverted loop (Slice 3): spike vs implement run listing. Built CONCURRENTLY in
-- its own migration so "coding_run" is not write-locked.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "coding_run_kind_idx" ON "coding_run"("kind");
