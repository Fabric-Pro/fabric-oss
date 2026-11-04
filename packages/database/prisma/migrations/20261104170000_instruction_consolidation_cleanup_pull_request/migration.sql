-- AlterTable
ALTER TABLE "instruction_consolidation" ADD COLUMN     "cleanupHeadSha" TEXT,
ADD COLUMN     "cleanupMergedAt" TIMESTAMP(3),
ADD COLUMN     "cleanupPullRequestId" TEXT;
