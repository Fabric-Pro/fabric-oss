-- PM sync attempt fence and pending-since bound.
--
-- `lastPmSyncAttemptId` holds the UUID of the enqueue attempt that last
-- stamped the item PENDING, so a failed workflow start compensates only its
-- own attempt. `pmSyncPendingSince` records when the current PENDING began;
-- the stuck-sync watchdog's give-up bound reads it so that the watchdog's
-- own retries (which refresh `lastPmSyncAttemptAt`) cannot postpone giving
-- up indefinitely. Both are nullable with no backfill: existing rows fall
-- back to `lastPmSyncAttemptAt`, and the next enqueue fills them in.
-- Additive only: the previous app version ignores both columns.

-- AlterTable
ALTER TABLE "test_case" ADD COLUMN     "lastPmSyncAttemptId" TEXT,
ADD COLUMN     "pmSyncPendingSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "lastPmSyncAttemptId" TEXT,
ADD COLUMN     "pmSyncPendingSince" TIMESTAMP(3);
