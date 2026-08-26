-- Publishing Suite 1C-1 follow-up: change the column default for NEW rows only.
-- Deliberately does not backfill existing rows: an existing row's cadence was
-- either explicitly chosen by an admin or defaulted under the old behaviour,
-- and rewriting someone's stored choice is not something a default change
-- should do. (In practice the table is empty today, since the flag has never
-- been enabled, but this migration must be correct regardless.)
ALTER TABLE "publishing_suite_settings" ALTER COLUMN "cadence" SET DEFAULT 'MANUAL';
