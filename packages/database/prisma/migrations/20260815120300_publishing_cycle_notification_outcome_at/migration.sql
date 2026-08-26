-- Publishing Suite 1C-2d-2a (Fizzy #2213): the explicit activation clock the
-- PENDING -> ABANDONED sweep reads.
--
-- lock_timeout FIRST. The ADD COLUMN below takes ACCESS EXCLUSIVE, so a timeout
-- declared after it would guard nothing — the mistake that shipped once on the
-- 1C-2c lease migration.
--
-- A nullable column with no default is metadata-only on PostgreSQL 11+, so the
-- lock is held for the catalog update alone.
--
-- ADD COLUMN IS ALONE IN THIS FILE, and that is the whole point of the file
-- existing. A lock taken inside a transaction is held until COMMIT, not until
-- the statement ends, so ANY statement sharing this file extends a total
-- lockout of publishing_suggestion_cycle by its own duration. The backfill is
-- the next file; the two VALIDATE scans are the one after that.
--
-- SET LOCAL still works here because this file has TWO statements and Prisma
-- wraps a multi-statement migration in one transaction -- measured, Task 2
-- Step 0, and independently recorded at docs/database-promotion.md:218-232.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "publishing_suggestion_cycle"
  ADD COLUMN "notificationOutcomeAt" TIMESTAMP(3);
