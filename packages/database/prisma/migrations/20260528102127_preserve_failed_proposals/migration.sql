-- AlterEnum
ALTER TYPE "PendingBacklogProposalSource" ADD VALUE 'AI_UPDATE_SIDEBAR';

-- AlterTable
ALTER TABLE "pending_backlog_proposal" ADD COLUMN     "errorClass" TEXT,
ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "failedAt" TIMESTAMP(3);
