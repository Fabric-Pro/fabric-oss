-- CreateEnum
CREATE TYPE "WorkflowIntegrationUsageScope" AS ENUM ('OWNER_ONLY', 'ORGANIZATION_SHARED');

-- AlterTable
ALTER TABLE "integration_approval" ADD COLUMN     "integrationId" TEXT;

-- AlterTable
ALTER TABLE "workflow_integration" ADD COLUMN     "usageScope" "WorkflowIntegrationUsageScope" NOT NULL DEFAULT 'OWNER_ONLY';
