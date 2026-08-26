-- AlterTable
ALTER TABLE "feature_version" ADD COLUMN     "changeSummary" TEXT[] DEFAULT ARRAY[]::TEXT[];
