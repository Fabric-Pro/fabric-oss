-- Inverted loop (plan §F2): active-run lookups by the denormalized story id.
-- Built CONCURRENTLY in its own migration so "weave_execution" is not write-locked.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "weave_execution_userStoryId_idx" ON "weave_execution"("userStoryId");
