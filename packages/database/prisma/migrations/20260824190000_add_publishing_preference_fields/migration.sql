-- AlterTable
-- The DEFAULT on the two array columns is load-bearing, not decoration: on a
-- populated table `ADD COLUMN ... NOT NULL` without one is refused outright
-- ("column contains null values"). With it, existing rows are backfilled to {}.
--
-- "PublishingTopicPostType" already exists; this migration must NOT create it.
ALTER TABLE "publishing_suite_settings"
  ADD COLUMN "preferredThemes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "preferredPostTypes" "PublishingTopicPostType"[] NOT NULL DEFAULT ARRAY[]::"PublishingTopicPostType"[],
  ADD COLUMN "strategicPriorities" TEXT;
