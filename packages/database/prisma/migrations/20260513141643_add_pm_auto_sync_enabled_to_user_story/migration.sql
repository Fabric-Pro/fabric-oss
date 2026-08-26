-- AlterTable
ALTER TABLE "user_story"
  ADD COLUMN "pmAutoSyncEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing PM-linked rows so observable behavior is unchanged on
-- day one. New Fabric-created stories continue to land at the column
-- default of false; create paths that stamp `externalId` at create time
-- explicitly set `pmAutoSyncEnabled: true` (see spec §5.3).
UPDATE "user_story"
   SET "pmAutoSyncEnabled" = true
 WHERE "externalId" IS NOT NULL;
