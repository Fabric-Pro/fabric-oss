-- AlterTable
ALTER TABLE "agent_deployment_trigger" ADD COLUMN     "projectId" TEXT;

-- CreateIndex
CREATE INDEX "agent_deployment_trigger_projectId_idx" ON "agent_deployment_trigger"("projectId");

-- AddForeignKey
ALTER TABLE "agent_deployment_trigger" ADD CONSTRAINT "agent_deployment_trigger_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
