-- Fizzy #2355 — make a broken meeting sync visible and repairable.
--
-- Failure state mirrors what the three channel-monitor models already carry.
-- Meetings had none, which is why a dead sync looked healthy: the Graph call
-- threw, the activity swallowed it as a settled state, and the run still
-- stamped a clean lastRun.
ALTER TABLE "project_linked_meeting"
  ADD COLUMN IF NOT EXISTS "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastErrorMessage" TEXT,
  ADD COLUMN IF NOT EXISTS "lastErrorAt" TIMESTAMP(3);

-- Which user's delegated Microsoft token the sync runs on. It was frozen into
-- the Temporal workflow's arguments at enable-time and unreachable from SQL, so
-- nothing could show whose account a project depended on, or that it had gone.
ALTER TABLE "project"
  ADD COLUMN IF NOT EXISTS "meetingTranscriptSyncUserId" TEXT;
