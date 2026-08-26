-- AlterTable: Blocked flag + optional reason on a work item (mirrors needsMoreInfo).
ALTER TABLE "user_story" ADD COLUMN "blocked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_story" ADD COLUMN "blockedReason" TEXT;
