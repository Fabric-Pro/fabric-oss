-- CreateEnum
CREATE TYPE "MaturationStatus" AS ENUM ('TO_DO', 'DISCOVERY', 'DONE');

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "maturationStatus" "MaturationStatus";

-- Backfill the new "dummy" Maturation V2 status from the existing drafting
-- stage so legacy rows surface a sensible label. This mapping MUST stay in sync
-- with deriveMaturationStatus() on the client (apps/web/.../lib/stories/types.ts):
--   PLACEHOLDER / DECLINED                                  -> TO_DO
--   PASSIVE_ANALYSIS / ACTIVE_ANALYSIS / SANITY_CHECK / DRAFT -> DISCOVERY
--   PUBLISHED / CLOSED                                      -> DONE
UPDATE "user_story"
SET "maturationStatus" = CASE "draftingStage"
    WHEN 'PLACEHOLDER'      THEN 'TO_DO'::"MaturationStatus"
    WHEN 'DECLINED'         THEN 'TO_DO'::"MaturationStatus"
    WHEN 'PASSIVE_ANALYSIS' THEN 'DISCOVERY'::"MaturationStatus"
    WHEN 'ACTIVE_ANALYSIS'  THEN 'DISCOVERY'::"MaturationStatus"
    WHEN 'SANITY_CHECK'     THEN 'DISCOVERY'::"MaturationStatus"
    WHEN 'DRAFT'            THEN 'DISCOVERY'::"MaturationStatus"
    WHEN 'PUBLISHED'        THEN 'DONE'::"MaturationStatus"
    WHEN 'CLOSED'           THEN 'DONE'::"MaturationStatus"
END;
