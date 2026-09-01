-- Routes an open maturation question to the people who can answer it (Fizzy #1751).
--
-- TENANCY: `userId` is the tenant key and mirrors the parent decision_log_entry's owner.
-- It is deliberately NOT the assignee — the `user_owned` RLS policy matches
-- "userId" = current_user_id() on its personal branch, so naming the assignee `userId`
-- would scope the row to the person being asked instead of the tenant that owns the
-- question. The assignee is "assigneeUserId".
--
-- No status column: a question's `Assigned` state is derived from
-- (has assignees AND status = 'OPEN'), because a new DecisionStatus member would fall
-- out of the status = 'OPEN' predicates in getOpenQuestionCounts and
-- markQuestionsPossiblyResolved and silently break both.

-- CreateTable
CREATE TABLE "decision_log_entry_assignee" (
    "id" TEXT NOT NULL,
    "decisionLogEntryId" TEXT NOT NULL,
    "assigneeUserId" TEXT NOT NULL,
    "assignedByUserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_log_entry_assignee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Indexes are created alongside the table, so CONCURRENTLY is neither required nor
-- permitted here (it cannot run inside the migration's transaction).
CREATE UNIQUE INDEX "decision_log_entry_assignee_decisionLogEntryId_assigneeUse_key" ON "decision_log_entry_assignee"("decisionLogEntryId", "assigneeUserId");

-- CreateIndex
CREATE INDEX "decision_log_entry_assignee_decisionLogEntryId_idx" ON "decision_log_entry_assignee"("decisionLogEntryId");

-- CreateIndex
CREATE INDEX "decision_log_entry_assignee_assigneeUserId_idx" ON "decision_log_entry_assignee"("assigneeUserId");

-- CreateIndex
CREATE INDEX "decision_log_entry_assignee_organizationId_idx" ON "decision_log_entry_assignee"("organizationId");

-- CreateIndex
CREATE INDEX "decision_log_entry_assignee_userId_idx" ON "decision_log_entry_assignee"("userId");

-- AddForeignKey
ALTER TABLE "decision_log_entry_assignee" ADD CONSTRAINT "decision_log_entry_assignee_decisionLogEntryId_fkey" FOREIGN KEY ("decisionLogEntryId") REFERENCES "decision_log_entry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_log_entry_assignee" ADD CONSTRAINT "decision_log_entry_assignee_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_log_entry_assignee" ADD CONSTRAINT "decision_log_entry_assignee_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_log_entry_assignee" ADD CONSTRAINT "decision_log_entry_assignee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_log_entry_assignee" ADD CONSTRAINT "decision_log_entry_assignee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
