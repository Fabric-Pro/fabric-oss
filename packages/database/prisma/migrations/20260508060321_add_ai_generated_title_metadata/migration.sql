-- CreateEnum
CREATE TYPE "StoryTitleSource" AS ENUM ('AI', 'DESCRIPTION_FALLBACK', 'UNTITLED_FALLBACK');

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "aiGeneratedTitle" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "titleSource" "StoryTitleSource";
