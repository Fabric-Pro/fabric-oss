-- A repository's first Living Memory sync no longer reads every file for
-- decisions. Each file it creates records the content version it skipped, so a
-- member can ask for those files to be scanned later, and a later edit is read
-- as usual because its hash no longer matches.
--
-- Nullable, no default, no backfill: existing files were already read when
-- they were embedded. Additive and idempotent. RLS is table-level, so the
-- existing policies cover the new column.

-- AlterTable
ALTER TABLE "project_context" ADD COLUMN IF NOT EXISTS "decisionScanSkippedHash" TEXT;
