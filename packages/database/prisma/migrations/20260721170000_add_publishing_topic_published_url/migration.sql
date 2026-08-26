-- AlterTable: optional user-entered published URL for a topic (FR14/FR15/DV5).
-- Nullable, no default — topics without a URL stay NULL. Cleared to NULL on any
-- transition out of PUBLISHED by updatePublishingTopicStatus. No strict
-- validation (DV6). Additive; no backfill needed.
ALTER TABLE "publishing_topic" ADD COLUMN "publishedUrl" TEXT;
