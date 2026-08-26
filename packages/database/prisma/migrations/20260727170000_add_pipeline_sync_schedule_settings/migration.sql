-- Per-project control over the automatic pipeline-result sync (spec F1).
--
-- The sweep stays a SINGLE deployment-wide Temporal schedule; these two columns
-- are read by the enumerator that decides who it visits. That keeps the interval
-- a per-project FLOOR rather than a rival cadence, and avoids reconciling a
-- Temporal schedule per project as projects come and go.
--
-- Defaults reproduce today's behaviour exactly: every qualifying project syncs
-- automatically, no less than 15 minutes apart, which is the constant the sweep
-- already ran at. No project changes behaviour on deploy.
ALTER TABLE "project_qa_settings"
  ADD COLUMN "pipelineSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "pipelineSyncIntervalMinutes" INTEGER NOT NULL DEFAULT 15;
