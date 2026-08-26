-- Publishing Suite 1C-2b: the in-app toggle for the PUBLISHING notification category.
-- Opt-out model, matching every other flag on this table: default true, only an explicit false
-- suppresses. NOT NULL with a DEFAULT is a fast metadata-only change on PostgreSQL 11+ — no
-- rewrite, no long lock.
ALTER TABLE "notification_preference"
  ADD COLUMN "publishingSuggestions" BOOLEAN NOT NULL DEFAULT true;
