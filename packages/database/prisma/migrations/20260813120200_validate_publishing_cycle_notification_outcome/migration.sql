-- Publishing Suite 1C-2c discharges the obligation 1C-2b recorded.
--
-- 20260812120200 added this CHECK NOT VALID because publishing_suggestion_cycle has been live
-- since Phase 1A and a validating ADD CONSTRAINT takes ACCESS EXCLUSIVE while it scans every
-- row. VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE, so concurrent reads and writes
-- continue while the scan runs — which is the whole point of splitting the two, and the reason
-- the split is only real ACROSS releases: `promote` runs every pending migration in one
-- `prisma migrate deploy` pass, so two files in one release are not separately scheduled.
--
-- The matching entry is deleted from pending-constraint-validations.json in this same change.
-- scripts/lint-migrations.ts fails on a stale entry whose VALIDATE has already landed, so
-- leaving it behind is a red CI check rather than a quiet inconsistency.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "publishing_suggestion_cycle"
  VALIDATE CONSTRAINT "publishing_suggestion_cycle_notification_outcome_check";
