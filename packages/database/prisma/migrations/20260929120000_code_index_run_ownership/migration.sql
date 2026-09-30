-- AlterTable
ALTER TABLE "project_code_index" ADD COLUMN     "ownerRunId" TEXT,
ADD COLUMN     "ownerRunStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "background_job" ADD COLUMN     "runStartedAt" TIMESTAMP(3);
