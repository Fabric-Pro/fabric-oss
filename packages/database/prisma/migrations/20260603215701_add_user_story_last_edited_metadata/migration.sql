-- CreateEnum
CREATE TYPE "LastEditSource" AS ENUM ('MANUAL', 'AI_BACKLOG_UPDATE', 'AI_MATURATION', 'CONFLICT_RESOLUTION', 'PM_PULL');

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "lastEditedByName" TEXT,
ADD COLUMN     "lastEditedSource" "LastEditSource";
