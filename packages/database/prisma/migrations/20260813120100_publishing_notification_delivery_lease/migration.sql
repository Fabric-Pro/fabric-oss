-- Must be the first executable statement: it bounds every lock this file takes, and the very next
-- statement below (ALTER TABLE ... ADD COLUMN) takes ACCESS EXCLUSIVE, so a SET LOCAL placed after
-- it would leave that lock unbounded.
SET LOCAL lock_timeout = '5s';

-- Publishing Suite 1C-2c: the EMAIL lease columns and the status value they produce.
--
-- Both nullable and unset for every existing row, which is correct: IN_APP delivery never takes
-- a lease. Its ledger row and its Notification row commit in ONE transaction, so the unique
-- (cycleId, recipientUserId, channel) index is already the fence. Email cannot join that
-- transaction, which is the entire reason these two columns exist.
ALTER TABLE "publishing_notification_delivery"
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3);

-- lastAttemptAt is deliberately NOT the same thing as claimedAt, even though both are stamped by
-- the same statement. claimedAt is a LEASE and is released on a known failure so the next attempt
-- can recover at once. lastAttemptAt is a FACT about the outside world — a message may have been
-- handed to the provider at this instant — and nothing may clear it, because `sendEmail` returning
-- false is ambiguous: it covers a provider error that can arrive after the provider accepted.
-- Without a field that outlives the lease release, a FAILED row reads as never-attempted and the
-- provider's 24h idempotency key silently stops covering it.

-- Widening the status CHECK to admit SENDING, through the expand sequence.
--
-- NOT VALID even though the new predicate admits a strict SUPERSET of the old one's values, so
-- every existing row satisfies it as a matter of logic rather than of luck. PostgreSQL cannot see
-- that and would scan under ACCESS EXCLUSIVE, and scripts/lint-migrations.ts rejects a validating
-- ADD CONSTRAINT on any table that existed in an earlier migration — this one was created by
-- 1C-2b, one release ago.
--
-- The rule has an escape hatch and this deliberately does not use it. A `-- migration-lint: allow`
-- marker carries no expiry; the entry in pending-constraint-validations.json carries a deadline the
-- linter enforces. Suppressing the rule here would also contradict the next migration in this same
-- slice, which exists precisely because an exception list with no expiry is not a control.
--
-- Nothing is deferred that matters: NOT VALID still checks every NEW row, and new rows are the only
-- thing a widening affects. The VALIDATE lands in 1C-2d, declared in the JSON ledger.
ALTER TABLE "publishing_notification_delivery"
  DROP CONSTRAINT "publishing_notification_delivery_status_check";

ALTER TABLE "publishing_notification_delivery"
  ADD CONSTRAINT "publishing_notification_delivery_status_check"
  CHECK ("status" IN ('SENT','FAILED','SKIPPED','SENDING')) NOT VALID;
