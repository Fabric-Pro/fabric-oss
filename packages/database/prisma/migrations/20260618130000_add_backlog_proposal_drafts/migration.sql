-- CreateEnum
CREATE TYPE "BacklogProposalDraftStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "predraftProposalsOnOpen" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "backlog_proposal_draft" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "kind" "StoryKind" NOT NULL,
    "status" "BacklogProposalDraftStatus" NOT NULL DEFAULT 'RUNNING',
    "description" TEXT,
    "acceptanceCriteria" TEXT,
    "needsMoreInfo" BOOLEAN,
    "workflowId" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdBy" TEXT,

    CONSTRAINT "backlog_proposal_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backlog_proposal_draft_proposalId_idx" ON "backlog_proposal_draft"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "backlog_proposal_draft_proposalId_kind_key" ON "backlog_proposal_draft"("proposalId", "kind");

-- AddForeignKey
ALTER TABLE "backlog_proposal_draft" ADD CONSTRAINT "backlog_proposal_draft_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "pending_backlog_proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
