-- AlterTable
ALTER TABLE "project" ADD COLUMN     "googleDriveAutoSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "googleDriveAutoSyncIntervalMin" INTEGER,
ADD COLUMN     "googleDriveAutoSyncLastRun" TIMESTAMP(3),
ADD COLUMN     "googleDriveAutoSyncWorkflowId" TEXT;
