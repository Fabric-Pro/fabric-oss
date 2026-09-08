-- AlterTable
-- The two pieces of per-document state the queue needs. Kept apart from the three
-- enum migrations alongside it: each of those has to stand alone anyway, since a
-- value added by ALTER TYPE cannot be referenced in the transaction that adds it.
--
-- generationQueueReason is the coarse dependency category the run is currently
-- waiting on, rendered to the user as the reason the document has not started
-- yet. generationNotificationEmittedAt is the exactly-once claim on the
-- completion/failure notification: whoever writes it from NULL owns emitting it,
-- so a retried activity or a second terminal path cannot notify the requester
-- twice.
--
-- Both are nullable with no default. NULL means "not waiting" and "not yet
-- notified", which is correct for every row that already exists, so no backfill
-- is needed.
ALTER TABLE "project_document"
  ADD COLUMN IF NOT EXISTS "generationQueueReason" TEXT,
  ADD COLUMN IF NOT EXISTS "generationNotificationEmittedAt" TIMESTAMP(3);
