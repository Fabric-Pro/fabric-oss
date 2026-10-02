-- CreateEnum
CREATE TYPE "ProjectInstructionSnapshotProgressPhase" AS ENUM ('CHECKING', 'SAVING', 'SCANNING');

-- CreateEnum
CREATE TYPE "ProjectInstructionSyncProgressPhase" AS ENUM ('FETCHING', 'PREPARING', 'COPYING');

-- AlterTable
ALTER TABLE "project_instruction_repository_sync_run" ADD COLUMN     "progressDone" INTEGER,
ADD COLUMN     "progressPhase" "ProjectInstructionSyncProgressPhase",
ADD COLUMN     "progressTotal" INTEGER,
ADD COLUMN     "progressUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "project_instruction_snapshot" ADD COLUMN     "progressDone" INTEGER,
ADD COLUMN     "progressPhase" "ProjectInstructionSnapshotProgressPhase",
ADD COLUMN     "progressTotal" INTEGER,
ADD COLUMN     "progressUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "validationAttemptId" TEXT;
