-- AlterTable
ALTER TABLE "project" ADD COLUMN "primaryWebsiteUrl" TEXT,
ADD COLUMN "additionalWebsiteUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
