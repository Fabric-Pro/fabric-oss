-- CreateEnum
CREATE TYPE "CodeAnalysisStatus" AS ENUM ('SCANNING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "codeAnalysisStatus" "CodeAnalysisStatus",
ADD COLUMN     "codeAnalysisWorkflowId" TEXT;
