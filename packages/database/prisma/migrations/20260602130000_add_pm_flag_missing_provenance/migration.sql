-- AlterTable
ALTER TABLE "pending_pm_state_change" ADD COLUMN     "expectedExternalMcpServerId" TEXT;

-- AlterTable
ALTER TABLE "pm_ticket_missing_streak" ADD COLUMN     "lastCountedRunId" TEXT;
