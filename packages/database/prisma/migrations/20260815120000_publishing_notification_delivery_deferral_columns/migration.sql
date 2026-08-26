-- Publishing Suite 1C-2d-1 (Fizzy #2213): the two columns the deferral lifecycle needs.
--
-- lock_timeout FIRST. The single ALTER TABLE below, with its two ADD COLUMN
-- clauses, takes ACCESS EXCLUSIVE, so a timeout declared after it would guard
-- nothing — that mistake shipped once on the 1C-2c lease migration and was
-- corrected there.
--
-- Neither column rewrites the table on PostgreSQL 11+: a nullable column is
-- metadata-only, and a NOT NULL column with a constant default stores the default
-- in the catalog rather than backfilling every row. So the lock is held for the
-- catalog update alone.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "publishing_notification_delivery"
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
