-- PM → Fabric status sync (Fizzy #2304).
--
-- project:
--   "pmStatusSyncEnabled"   the per-project switch. Off by default, so no
--                           project changes behaviour until an admin opts in.
--   "pmStatusSyncSessionAt" when the switch last went from off to on. Every
--                           last-run write is conditioned on it.
--   "pmStatusSyncLastRun"   the last run's summary (pmStatusSyncLastRunSchema).
-- user_story — the per-story merge base:
--   "pmStatusSyncBaseId"    the linked ticket's last observed mapped status: a
--                           status id or a __none__ / __ambiguous__ /
--                           __terminal__ sentinel;
--   "pmStatusSyncBaseAt"    the ticket clock it was observed at;
--   "pmStatusSyncBaseLink"  the link it was observed through. The base counts
--                           only while this still equals the story's link;
--   "pmStatusSyncBaseFabricId" the Fabric status the observation was made
--                           against. The push compares the story's status
--                           with it to tell a Fabric move from a ticket one.
--
-- Expand-safe: every column is nullable or has a constant default, so each ADD
-- COLUMN is a catalog-only change on PostgreSQL 11+ (no table rewrite, no
-- backfill), and the previous application version never reads these columns.

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "pmStatusSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pmStatusSyncLastRun" JSONB,
ADD COLUMN     "pmStatusSyncSessionAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "pmStatusSyncBaseAt" TIMESTAMP(3),
ADD COLUMN     "pmStatusSyncBaseFabricId" TEXT,
ADD COLUMN     "pmStatusSyncBaseId" TEXT,
ADD COLUMN     "pmStatusSyncBaseLink" TEXT;
