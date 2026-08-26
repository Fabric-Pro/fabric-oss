-- CreateEnum
CREATE TYPE "AutonomyLevel" AS ENUM ('CONSERVATIVE', 'BALANCED', 'AUTONOMOUS');

-- AlterTable
ALTER TABLE "registered_agent" ADD COLUMN     "autonomyLevel" "AutonomyLevel" NOT NULL DEFAULT 'BALANCED';

-- AlterTable
ALTER TABLE "user_orchestrator_preferences" ADD COLUMN     "autonomyLevel" "AutonomyLevel" NOT NULL DEFAULT 'BALANCED';

-- AddForeignKey
ALTER TABLE "approval_template" ADD CONSTRAINT "approval_template_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
