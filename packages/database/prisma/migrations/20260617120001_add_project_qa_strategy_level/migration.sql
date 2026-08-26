-- CreateEnum
CREATE TYPE "QaStrategyLevel" AS ENUM ('LIGHT', 'STANDARD', 'STRICT');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "qaStrategyLevel" "QaStrategyLevel" NOT NULL DEFAULT 'STANDARD';
