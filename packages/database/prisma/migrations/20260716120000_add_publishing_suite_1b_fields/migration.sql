-- CreateEnum
CREATE TYPE "PublishingTopicPostType" AS ENUM ('TWEET', 'BLOG_POST', 'CASE_STUDY', 'STAKEHOLDER_EMAIL');

-- AlterTable
ALTER TABLE "publishing_topic"
  ADD COLUMN "suggestedPostTypes" "PublishingTopicPostType"[] NOT NULL DEFAULT ARRAY[]::"PublishingTopicPostType"[],
  ADD COLUMN "contributorUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill pre-existing MANUAL topics: their sole contributor is the creator
-- (FR-11a / DV-8), matching createManualPublishingTopic's go-forward stamping,
-- so historical rows render the creator chip instead of an empty contributor row.
-- Idempotent: only touches rows still at the default empty array.
UPDATE "publishing_topic"
SET "contributorUserIds" = ARRAY["createdById"]
WHERE "origin" = 'MANUAL'
  AND "createdById" IS NOT NULL
  AND "contributorUserIds" = ARRAY[]::TEXT[];
