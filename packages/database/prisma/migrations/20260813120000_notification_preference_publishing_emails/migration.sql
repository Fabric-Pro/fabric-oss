-- Must be the first executable statement, so it bounds the ACCESS EXCLUSIVE the ALTER TABLE below
-- takes. That lock is cheap here — ADD COLUMN with a constant DEFAULT is metadata-only on PG11+
-- and does not rewrite the table — so this guard is not what makes the statement safe. It is here
-- because every other migration in this slice bounds its locks, and a rule with one silent
-- exception is the rule the next person learns is optional.
SET LOCAL lock_timeout = '5s';

-- Publishing Suite 1C-2c: the EMAIL-channel opt-out for publishing suggestions.
--
-- Opt-out model, matching reportEmails and reviewEmails: a missing preference row means
-- enabled, and only an explicit false suppresses the email. NOT NULL DEFAULT true fills every
-- existing row in place, so no backfill statement follows — one that matched zero rows would
-- read as load-bearing to the next person to open this file.
ALTER TABLE "notification_preference"
  ADD COLUMN "publishingEmails" BOOLEAN NOT NULL DEFAULT true;
