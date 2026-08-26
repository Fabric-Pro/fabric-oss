-- AlterEnum
ALTER TYPE "pending_pm_state_change_action" ADD VALUE 'CONTENT_DRIFT';

-- AlterTable
ALTER TABLE "pending_pm_state_change" ADD COLUMN "detectedPmHash" TEXT;
