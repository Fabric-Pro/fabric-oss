-- Priority-flag lookup index on the populated architecture_decision table,
-- built CONCURRENTLY so deploys don't take a whole-table write lock.
-- Single-statement migration: Prisma does not wrap a lone statement in a
-- transaction, and CONCURRENTLY cannot run inside one.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "architecture_decision_projectId_priorityFlagged_idx" ON "architecture_decision"("projectId", "priorityFlagged");
