-- Coding Instructions repository sync: when the instruction reaper last
-- claimed an unfinished run receipt (Fizzy #2672).
--
-- The reaper asks Temporal about the oldest unfinished receipts, a bounded
-- batch per hourly tick, and completes only those whose run has ended. A
-- receipt whose run is still open, or whose describe went unanswered, stays
-- unfinished, so ordering by age alone re-selected the same batch every tick
-- and a later receipt for a run that had ended was never examined. The
-- reaper now stamps each receipt it claims and takes the least recently
-- checked first, rotating through every candidate.
--
-- Additive and nullable: no rewrite, no backfill (null sorts first, which is
-- "never checked"), and the previous app version neither reads nor writes it.
-- The partial index that serves the claim is built CONCURRENTLY in the next
-- migration, 20260924180100, which must stay a single statement.
--
-- lock_timeout FIRST, per the convention in this directory: the timeout has to
-- be in force BEFORE the statement that takes the lock, or it guards nothing
-- (see 20260815120300_publishing_cycle_notification_outcome_at). A migration
-- that cannot get its ACCESS EXCLUSIVE lock within 5s fails and is retried
-- off-peak; one that waits unbounded queues every later query on the table
-- behind itself. SET LOCAL applies because this file has two statements, and
-- Prisma wraps a multi-statement migration in one transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "project_instruction_repository_sync_run" ADD COLUMN "reapCheckedAt" TIMESTAMP(3);
