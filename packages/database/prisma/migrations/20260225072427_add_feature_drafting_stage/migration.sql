-- CreateEnum
CREATE TYPE "FeatureDraftingStage" AS ENUM ('PLACEHOLDER', 'PASSIVE_ANALYSIS', 'ACTIVE_ANALYSIS', 'SANITY_CHECK', 'DRAFT', 'PUBLISHED', 'DECLINED');

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "draftingStage" "FeatureDraftingStage" NOT NULL DEFAULT 'PLACEHOLDER',
ADD COLUMN     "draftingStageUpdatedAt" TIMESTAMP(3);
