-- DropForeignKey
ALTER TABLE "public"."epic" DROP CONSTRAINT "epic_projectId_fkey";

-- DropForeignKey
ALTER TABLE "public"."feature" DROP CONSTRAINT "feature_epicId_fkey";

-- DropForeignKey
ALTER TABLE "public"."feature" DROP CONSTRAINT "feature_projectId_fkey";

-- DropForeignKey
ALTER TABLE "public"."user_story" DROP CONSTRAINT "user_story_featureId_fkey";

-- DropIndex
DROP INDEX "public"."user_story_featureId_idx";

-- AlterTable
ALTER TABLE "user_story" DROP COLUMN "featureId";

-- DropTable
DROP TABLE "public"."epic";

-- DropTable
DROP TABLE "public"."feature";

