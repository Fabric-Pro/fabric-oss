-- Feature Maturation V2 — Project-level hidden stage configurations
-- AlterTable
ALTER TABLE "project" ADD COLUMN     "hiddenMaturationStatuses" TEXT[] DEFAULT ARRAY[]::TEXT[];
