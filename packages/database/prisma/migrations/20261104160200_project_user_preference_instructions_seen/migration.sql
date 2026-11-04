-- The Coding Instructions version each person last looked at, for the tab's
-- "what changed since your last visit" digest. Nullable, no default, no
-- backfill: a row without a marker is a first visit, which shows no digest
-- and records the marker. `instructionsSeenSnapshotId` is deliberately not a
-- foreign key, so a pruned snapshot leaves the version number to fall back on.

-- AlterTable
ALTER TABLE "project_user_preference" ADD COLUMN IF NOT EXISTS "instructionsSeenSnapshotId" TEXT,
ADD COLUMN IF NOT EXISTS "instructionsSeenVersion" INTEGER,
ADD COLUMN IF NOT EXISTS "instructionsSeenAt" TIMESTAMP(3);
