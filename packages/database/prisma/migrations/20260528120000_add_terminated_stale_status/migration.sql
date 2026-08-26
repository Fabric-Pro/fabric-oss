-- Adds TERMINATED_STALE to the two execution status enums so the watchdog
-- cron can mark non-terminal Weave/CodingRun rows that exceeded the
-- workflow's hard ceiling, and writes a paper trail without colliding with
-- FAILED (which means the workflow's own error path ran).
ALTER TYPE "CodingRunStatus" ADD VALUE IF NOT EXISTS 'TERMINATED_STALE';
ALTER TYPE "WeaveExecutionStatus" ADD VALUE IF NOT EXISTS 'TERMINATED_STALE';

-- CodingRun: track when the workflow started executing (for the watchdog's
-- staleness check) and capture the last error message written by the
-- workflow's finally cleanup or the watchdog's force-terminate path.
ALTER TABLE "coding_run" ADD COLUMN IF NOT EXISTS "started_at" TIMESTAMP(3);
ALTER TABLE "coding_run" ADD COLUMN IF NOT EXISTS "last_error" TEXT;

-- Composite indexes that bound the watchdog scan to the rows it cares
-- about: non-terminal status with a known start time older than the
-- configured ceiling.
CREATE INDEX IF NOT EXISTS "coding_run_status_startedAt_idx"
  ON "coding_run" ("status", "started_at");
CREATE INDEX IF NOT EXISTS "weave_execution_status_startedAt_idx"
  ON "weave_execution" ("status", "startedAt");
