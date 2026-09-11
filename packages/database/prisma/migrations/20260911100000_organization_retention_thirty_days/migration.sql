-- The organization retention window moves from 7 days to 30 (Fizzy #2462).
--
-- `scheduledPermanentDeleteAt` is stamped at deletion time and never recomputed,
-- which is what lets the UI promise "recoverable until <date>" and mean it. The
-- cost of that property is this migration: an organization already inside the
-- corridor carries a purge date computed from the old window, so without a
-- re-stamp it would be destroyed on day 7 while every screen and both emails
-- now say 30.
--
-- Only ever EXTENDS. The `<` guard makes it idempotent and means a future
-- shortening of the window can never reach a row through this statement — the
-- one thing the stamped-at-deletion design exists to prevent.
--
-- Rows already past their purge date are left alone: the sweep may be mid-flight
-- on them, and reviving something the system has already begun to destroy is not
-- what a window change asks for.

UPDATE "organization"
SET "scheduledPermanentDeleteAt" = "deletedAt" + INTERVAL '30 days'
WHERE "deletedAt" IS NOT NULL
  AND "scheduledPermanentDeleteAt" IS NOT NULL
  AND "scheduledPermanentDeleteAt" > NOW()
  AND "scheduledPermanentDeleteAt" < "deletedAt" + INTERVAL '30 days';
