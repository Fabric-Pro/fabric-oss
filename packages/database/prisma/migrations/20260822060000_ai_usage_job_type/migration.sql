-- Invocation-source attribution (Fizzy #1894): when set, the call came from
-- a scheduled or background pipeline rather than a user action; the value is
-- the job-type label ("scheduled-report", "meeting-transcript-sync", ...).
-- Nullable by design - user-initiated rows stay null.
ALTER TABLE "ai_usage_log" ADD COLUMN "jobType" TEXT;
