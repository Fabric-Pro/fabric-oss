-- Coding Instructions repository sync: run receipts survive a disable or a
-- disconnect (Fizzy #2672), matching the Living Memory receipt
-- ("project_context_repository_sync_run" has never had this foreign key).
--
-- The ON DELETE CASCADE from "project_instruction_repository_sync" removed
-- every receipt when a project switched back to upload mode or its
-- repository was disconnected: History went empty, and a run in flight at
-- that moment could never write its NOT_PUBLISHED receipt or its
-- completion audit row. "syncId" stays NOT NULL and keeps its index; it now
-- records the configuration the run was begun under, which may be gone.
--
-- Safe for the rolling deploy: the previous app version reads and writes the
-- same columns and only loses the cascade, so its disable keeps receipts
-- too. Dropping a foreign key rewrites and scans nothing; it takes a brief
-- lock on both tables.
--
-- lock_timeout FIRST, per the convention in this directory: the timeout has to
-- be in force BEFORE the statement that takes the lock, or it guards nothing
-- (see 20260815120300_publishing_cycle_notification_outcome_at). A migration
-- that cannot get its ACCESS EXCLUSIVE lock within 5s fails and is retried
-- off-peak; one that waits unbounded queues every later query on the table
-- behind itself. SET LOCAL applies because this file has two statements, and
-- Prisma wraps a multi-statement migration in one transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "project_instruction_repository_sync_run" DROP CONSTRAINT "project_instruction_repository_sync_run_syncId_fkey";
