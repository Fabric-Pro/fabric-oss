-- AlterTable: add the per-row PM auto-sync gate to epics and features,
-- mirroring the column already present on user_story. The column is additive
-- with a constant default, so Postgres adds it without a table rewrite and
-- existing rows are unaffected at insert time.
ALTER TABLE "epic"
  ADD COLUMN "pmAutoSyncEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "feature"
  ADD COLUMN "pmAutoSyncEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing PM-linked rows so observable behavior is unchanged on
-- day one: any epic/feature already linked to a PM work item keeps
-- auto-syncing under the per-row gate. New Fabric-created rows land at the
-- column default (false); create paths invoked with sync intent stamp true.
UPDATE "epic"
   SET "pmAutoSyncEnabled" = true
 WHERE "externalId" IS NOT NULL;

UPDATE "feature"
   SET "pmAutoSyncEnabled" = true
 WHERE "externalId" IS NOT NULL;
