-- When a person's Refresh of a proposal pull request was last admitted
-- (Fizzy #2563 spec §12, review round 1). The refresh is admitted by one
-- conditional UPDATE that also writes this column on the database clock, at
-- most once a minute per operation, so Refresh cannot be used to override a
-- backoff. No existing column can hold it: the workflow rewrites the failure
-- and observation JSON whole, the context is frozen at admission, and the
-- check and next-attempt times are what a refresh changes.
--
-- Nullable with no default and no backfill, so the ADD COLUMN is
-- metadata-only and takes no table rewrite. A NULL reads as "never
-- refreshed". No new table, so no RLS or tenant-extension change: the
-- snapshot table's policies apply to the new column.

-- AlterTable
ALTER TABLE "project_instruction_snapshot" ADD COLUMN     "pullRequestRefreshAdmittedAt" TIMESTAMP(3);
