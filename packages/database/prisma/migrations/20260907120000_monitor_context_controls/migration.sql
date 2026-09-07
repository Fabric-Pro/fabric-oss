-- Fizzy #2355 — bring the channel/chat monitors to parity with meeting sync:
-- pause a conversation without deleting it, and rebind a monitor whose bound
-- account has gone.
--
-- Deactivation is deliberately NOT a delete: the linked row, its seen-message
-- ledger, its polling cursor and the context already extracted from it all stay
-- live. Only each monitor's own lookup filters on this column, which is what
-- makes pausing the non-destructive alternative to unlinking.
--
-- Keeping the row rather than deleting it and preserving the context is the
-- whole point of the shape. The cursor and the seen-message ledger both hang off
-- this row, so deleting it and keeping the context would rescan from the top on
-- relink and re-append duplicate bundles into the very context row it preserved.
--
-- Both columns are nullable with no default: NULL means "actively scanned",
-- which is correct for every row that already exists, so no backfill is needed.
ALTER TABLE "project_linked_teams_chat"
  ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deactivatedById" TEXT;

ALTER TABLE "project_linked_teams_channel"
  ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deactivatedById" TEXT;

ALTER TABLE "project_linked_slack_channel"
  ADD COLUMN IF NOT EXISTS "deactivatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deactivatedById" TEXT;

-- Which user's delegated token each monitor runs on. Like the meeting sync
-- before it, this was frozen into the Temporal workflow's arguments at
-- enable-time and unreachable from SQL, so nothing could show whose account a
-- project depended on — and when that account lost access the scan returned an
-- empty list rather than an error, so the run still stamped a clean lastRun and
-- a dead monitor read as healthy.
ALTER TABLE "project"
  ADD COLUMN IF NOT EXISTS "teamsChatMonitorUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "teamsChannelMonitorUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "slackChannelMonitorUserId" TEXT;
