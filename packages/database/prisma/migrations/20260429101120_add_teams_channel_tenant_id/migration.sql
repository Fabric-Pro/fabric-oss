-- AlterTable
ALTER TABLE "project_linked_teams_channel" ADD COLUMN     "tenantId" TEXT;

-- CreateIndex
CREATE INDEX "project_linked_teams_channel_tenantId_idx" ON "project_linked_teams_channel"("tenantId");
