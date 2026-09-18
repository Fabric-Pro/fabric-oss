-- CreateEnum
CREATE TYPE "ProjectInstructionProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "project_instruction_snapshot" ADD COLUMN     "proposalStatus" "ProjectInstructionProposalStatus",
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewerUserId" TEXT;

-- CreateIndex
CREATE INDEX "project_instruction_snapshot_projectId_proposalStatus_idx" ON "project_instruction_snapshot"("projectId", "proposalStatus");

-- CreateIndex
CREATE INDEX "project_instruction_snapshot_reviewerUserId_idx" ON "project_instruction_snapshot"("reviewerUserId");

-- AddForeignKey
ALTER TABLE "project_instruction_snapshot" ADD CONSTRAINT "project_instruction_snapshot_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
