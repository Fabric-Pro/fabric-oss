-- CreateEnum
CREATE TYPE "ProjectInstructionProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "project_instruction_snapshot" ADD COLUMN     "proposalStatus" "ProjectInstructionProposalStatus",
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewerUserId" TEXT;

-- AddForeignKey
ALTER TABLE "project_instruction_snapshot" ADD CONSTRAINT "project_instruction_snapshot_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
