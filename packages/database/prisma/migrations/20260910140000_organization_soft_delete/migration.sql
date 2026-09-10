-- Organization deletion becomes a 7-day corridor rather than an event (Fizzy #2462).
--
-- The quartet mirrors `project` exactly, deliberately: the project soft-delete
-- has run in production since January and the purge worker, the reminder pass
-- and the restore path are all shaped around these four column names. Copying
-- the shape means the organization purge can copy the workflow too.
--
-- `scheduledPermanentDeleteAt` is STAMPED at deletion time, not computed at
-- purge time. That is the property that makes "recoverable until <date>" honest
-- — an operator who later shortens the retention window cannot retroactively
-- destroy an organization that is already in the corridor.
--
-- No backfill: every existing row is live by definition, which is exactly what
-- `deletedAt IS NULL` already says about it.
--
-- The index that serves the purge scan is deliberately NOT here. It is a
-- CREATE INDEX on an existing table, so it has to be CONCURRENTLY, and
-- CONCURRENTLY cannot run inside the transaction Prisma wraps a multi-statement
-- migration in. It ships alone in the migration that follows this one.

ALTER TABLE "organization" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "organization" ADD COLUMN "deletedBy" TEXT;
ALTER TABLE "organization" ADD COLUMN "scheduledPermanentDeleteAt" TIMESTAMP(3);
ALTER TABLE "organization" ADD COLUMN "deletionReminderSentAt" TIMESTAMP(3);
