-- AlterTable
ALTER TABLE "publishing_topic"
  ADD COLUMN "postTypesOverridden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "userPostTypes" "PublishingTopicPostType"[] NOT NULL DEFAULT ARRAY[]::"PublishingTopicPostType"[];
