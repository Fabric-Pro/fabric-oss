-- Fizzy #2355 — "Stop syncing" for a linked meeting.
--
-- Deactivation is deliberately NOT a delete: the row, its transcripts and the
-- context extracted from them all stay live and readable. Only the sync's own
-- lookup (getLinkedMeetingJoinUrls) filters on this column, which is what makes
-- stopping a meeting the non-destructive alternative to unlinking it.
--
-- Both columns are nullable with no default: NULL means "actively syncing",
-- which is correct for every row that already exists, so no backfill is needed.
ALTER TABLE "project_linked_meeting"
  ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deactivatedById" TEXT;
