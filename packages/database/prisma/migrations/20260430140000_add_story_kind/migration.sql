-- CreateEnum
CREATE TYPE "StoryKind" AS ENUM ('FEATURE', 'USER_STORY', 'BUG');

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN "kind" "StoryKind" NOT NULL DEFAULT 'FEATURE';
