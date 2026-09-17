-- "Is anything still deriving from this snapshot?" -- the question the delete
-- procedure and the retention prune ask before removing a snapshot whose
-- objects an in-flight derived snapshot still reads. Built CONCURRENTLY in its
-- own migration so "project_instruction_snapshot" is not write-locked.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "project_instruction_snapshot_baseSnapshotId_idx" ON "project_instruction_snapshot"("baseSnapshotId");
