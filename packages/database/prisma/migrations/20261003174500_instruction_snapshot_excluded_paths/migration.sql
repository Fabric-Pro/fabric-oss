-- AlterTable
-- The files a snapshot left out, as [{ path, rule }] capped at 500, kept beside
-- "excludedCount" so the Coding Instructions tab can list them and name the
-- rule that excluded each. The count stays the authoritative number. A
-- constant default makes this metadata-only on the populated snapshot table
-- (no rewrite, no backfill), and the previous app version, which never reads
-- or writes the column, is unaffected. Snapshots made before this column read
-- as an empty list, which the tab shows as the count alone.
ALTER TABLE "project_instruction_snapshot" ADD COLUMN "excludedPaths" JSONB NOT NULL DEFAULT '[]';
