-- CreateEnum
CREATE TYPE "parlume_meeting_agent_kind" AS ENUM ('FABRIC_AGENT', 'TEMPLATE_INSTANCE');

-- AlterTable
ALTER TABLE "parlume_meeting_session" ADD COLUMN     "agentKind" "parlume_meeting_agent_kind" NOT NULL DEFAULT 'TEMPLATE_INSTANCE',
ADD COLUMN     "agentLabel" TEXT NOT NULL DEFAULT 'Custom Fabric Agent',
ALTER COLUMN "agentInstanceSId" DROP NOT NULL,
ALTER COLUMN "agentInstanceVersionId" DROP NOT NULL,
ALTER COLUMN "agentInstanceVersion" DROP NOT NULL;

ALTER TABLE "parlume_meeting_session"
ADD CONSTRAINT "parlume_meeting_session_agent_selection"
CHECK (
  ("agentKind" = 'FABRIC_AGENT'
    AND "agentInstanceSId" IS NULL
    AND "agentInstanceVersionId" IS NULL
    AND "agentInstanceVersion" IS NULL)
  OR
  ("agentKind" = 'TEMPLATE_INSTANCE'
    AND "agentInstanceSId" IS NOT NULL
    AND "agentInstanceVersionId" IS NOT NULL
    AND "agentInstanceVersion" IS NOT NULL)
) NOT VALID;
