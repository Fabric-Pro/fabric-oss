-- AlterTable
ALTER TABLE "pending_backlog_proposal" ADD COLUMN     "applyReviewId" TEXT,
ADD COLUMN     "applyReviewWorkflowId" TEXT;

-- CreateTable
CREATE TABLE "pending_backlog_proposal_review" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "reviewedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "offeredCount" INTEGER NOT NULL,
    "offeredListComplete" BOOLEAN NOT NULL,
    "selectedCount" INTEGER NOT NULL,
    "syncToPM" BOOLEAN NOT NULL,
    "pmConfig" JSONB,

    CONSTRAINT "pending_backlog_proposal_review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_backlog_proposal_review_entry" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "offeredIndex" INTEGER NOT NULL,
    "changeIndex" INTEGER,
    "selected" BOOLEAN NOT NULL,
    "change" JSONB,
    "pmSyncOverride" JSONB,

    CONSTRAINT "pending_backlog_proposal_review_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_backlog_proposal_review_proposalId_createdAt_idx" ON "pending_backlog_proposal_review"("proposalId", "createdAt");

-- CreateIndex
CREATE INDEX "pending_backlog_proposal_review_entry_proposalId_idx" ON "pending_backlog_proposal_review_entry"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "pending_backlog_proposal_review_entry_reviewId_offeredIndex_key" ON "pending_backlog_proposal_review_entry"("reviewId", "offeredIndex");

-- migration-lint: allow unvalidated-constraint — applyReviewId is added nullable without a default above, so existing rows have no review references; the referenced table is new.
-- AddForeignKey
ALTER TABLE "pending_backlog_proposal" ADD CONSTRAINT "pending_backlog_proposal_applyReviewId_fkey" FOREIGN KEY ("applyReviewId") REFERENCES "pending_backlog_proposal_review"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_backlog_proposal_review" ADD CONSTRAINT "pending_backlog_proposal_review_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "pending_backlog_proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_backlog_proposal_review_entry" ADD CONSTRAINT "pending_backlog_proposal_review_entry_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "pending_backlog_proposal_review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_backlog_proposal_review_entry" ADD CONSTRAINT "pending_backlog_proposal_review_entry_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "pending_backlog_proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
