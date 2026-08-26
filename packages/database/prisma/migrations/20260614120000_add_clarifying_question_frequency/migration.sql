-- CreateEnum
CREATE TYPE "ClarifyingQuestionFrequency" AS ENUM ('MINIMAL', 'BALANCED', 'THOROUGH');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "clarifyingQuestionFrequency" "ClarifyingQuestionFrequency" NOT NULL DEFAULT 'BALANCED';
