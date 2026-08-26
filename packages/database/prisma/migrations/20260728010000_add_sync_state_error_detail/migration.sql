-- The provider's raw response body for the last sync failure.
--
-- Nullable with no backfill: rows written before this column existed recorded
-- the readable sentence only, and NULL is the honest record of "no raw body was
-- kept" rather than an empty string, which would render as a detail that exists
-- and says nothing.
ALTER TABLE "test_pipeline_sync_state" ADD COLUMN "lastErrorDetail" TEXT;
