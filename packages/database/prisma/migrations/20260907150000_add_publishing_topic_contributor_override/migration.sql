-- AlterTable
ALTER TABLE "publishing_topic"
  ADD COLUMN "contributorsOverridden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "userContributorUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
