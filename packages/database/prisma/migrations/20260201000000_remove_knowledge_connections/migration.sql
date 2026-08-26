-- Remove deprecated knowledgeConnections column from agent_template_instance
-- This column is replaced by the AgentIntegrationConfiguration relation

ALTER TABLE "agent_template_instance" DROP COLUMN IF EXISTS "knowledgeConnections";
