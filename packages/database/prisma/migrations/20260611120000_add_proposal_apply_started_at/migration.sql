-- Stuck-apply recovery: record when an apply workflow was dispatched for a
-- proposal so the watchdog (and manual cancel) can find proposals stuck mid-
-- apply. Nullable + forward-only: existing rows have no dispatch timestamp.
ALTER TABLE "pending_backlog_proposal" ADD COLUMN "applyStartedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "pending_backlog_proposal_status_applyStartedAt_idx" ON "pending_backlog_proposal"("status", "applyStartedAt");
