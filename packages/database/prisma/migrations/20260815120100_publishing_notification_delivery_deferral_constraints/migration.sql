-- Publishing Suite 1C-2d-1 (Fizzy #2213): admit the deferral lifecycle's two new
-- states, and forbid the one shape the lifecycle cannot terminate.
--
-- Both constraints ship NOT VALID and are declared in
-- prisma/pending-constraint-validations.json. 1C-2d-2 validates both. Two files in
-- one release are not separately scheduled — `promote` runs every pending migration
-- in one `prisma migrate deploy` pass — so the split is only real across releases.
--
-- The status CHECK is REPLACED rather than validated here: this migration widens the
-- very predicate 1C-2c left NOT VALID, and validating a constraint one is about to
-- drop buys nothing. The obligation is carried, not extended — the JSON entry keeps
-- 1C-2c's validateBy date.
--
-- NOT VALID skips the scan of EXISTING rows only. PostgreSQL enforces both predicates
-- on every insert and update from the moment they exist, so the shape guarantee below
-- is live immediately.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "publishing_notification_delivery"
  DROP CONSTRAINT "publishing_notification_delivery_status_check";

ALTER TABLE "publishing_notification_delivery"
  ADD CONSTRAINT "publishing_notification_delivery_status_check"
  CHECK ("status" IN ('SENT','FAILED','SKIPPED','SENDING','DEFERRED','EXPIRED')) NOT VALID;

-- A DEFERRED row with no expiry is never claimed (the claim requires
-- "expiresAt" > now()), never increments its attempt count, and never reaches
-- EXPIRED: an unbounded obligation inside a lifecycle whose entire claim is that it
-- is bounded. Enforced relationally so the state cannot be represented at all.
ALTER TABLE "publishing_notification_delivery"
  ADD CONSTRAINT "publishing_notification_delivery_deferred_shape"
  CHECK ("status" <> 'DEFERRED' OR "expiresAt" IS NOT NULL) NOT VALID;
