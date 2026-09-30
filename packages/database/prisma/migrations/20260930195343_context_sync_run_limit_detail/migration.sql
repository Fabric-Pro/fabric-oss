-- AlterTable
ALTER TABLE "project_context_repository_sync_run" ADD COLUMN     "limitDetail" JSONB,
ADD COLUMN     "reapCheckedAt" TIMESTAMP(3);
