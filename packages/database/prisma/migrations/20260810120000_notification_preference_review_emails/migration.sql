-- Per-user opt-out for the reviewer email sent when a release-notes draft parks
-- for approval (Fizzy #2172).
--
-- Mirrors `reportEmails`: it gates the EMAIL channel only and is deliberately
-- absent from CATEGORY_TO_TOGGLE, so the in-app approval-pending notification
-- stays unconditional. Default true, matching the opt-out model every delivery
-- flag on this table uses — a missing row means everything is on.
--
-- Additive and backfill-free: existing rows take the default.
ALTER TABLE "notification_preference"
  ADD COLUMN "reviewEmails" BOOLEAN NOT NULL DEFAULT true;
