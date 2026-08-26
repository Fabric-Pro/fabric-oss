-- AlterTable
ALTER TABLE "project" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "deletionReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "scheduledPermanentDeleteAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "project_deletedAt_idx" ON "project"("deletedAt");
