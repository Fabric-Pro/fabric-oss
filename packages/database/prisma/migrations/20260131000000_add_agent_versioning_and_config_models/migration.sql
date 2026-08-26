-- Agent Template Instance Versioning and Configuration Models Migration
-- This migration adds:
-- 1. AgentInstanceStatus enum (DRAFT, PENDING, ACTIVE, ARCHIVED)
-- 2. Versioning fields to AgentTemplateInstance (sId, version, status)
-- 3. AgentMCPServerConfiguration model for MCP server bindings
-- 4. AgentIntegrationConfiguration model for OAuth integration bindings

-- CreateEnum
CREATE TYPE "AgentInstanceStatus" AS ENUM ('DRAFT', 'PENDING', 'ACTIVE', 'ARCHIVED');

-- AlterEnum: Remove MASTRA from AgentFramework
BEGIN;
CREATE TYPE "AgentFramework_new" AS ENUM ('LANGGRAPH', 'MICROSOFT', 'PYDANTIC_AI', 'CREWAI', 'AUTOGEN', 'OPENAI', 'CUSTOM', 'A2A', 'MCP', 'ORCHESTRATOR', 'COPILOTKIT');
ALTER TABLE "agent" ALTER COLUMN "framework" TYPE "AgentFramework_new" USING ("framework"::text::"AgentFramework_new");
ALTER TABLE "azure_agent_deployment" ALTER COLUMN "framework" TYPE "AgentFramework_new" USING ("framework"::text::"AgentFramework_new");
ALTER TYPE "AgentFramework" RENAME TO "AgentFramework_old";
ALTER TYPE "AgentFramework_new" RENAME TO "AgentFramework";
DROP TYPE "public"."AgentFramework_old";
COMMIT;

-- DropIndex (old isActive index)
DROP INDEX IF EXISTS "public"."agent_template_instance_isActive_idx";

-- DropIndex (clean up drift indexes)
DROP INDEX IF EXISTS "public"."mcp_config_organizationId_userId_idx";
DROP INDEX IF EXISTS "public"."mcp_server_organizationId_userId_isSystemProvided_idx";

-- AlterTable: Add instanceVersion to conversations for version pinning
ALTER TABLE "agent_template_conversation" ADD COLUMN "instanceVersion" INTEGER;

-- AlterTable: Add versioning fields to agent_template_instance
-- First add columns as nullable
ALTER TABLE "agent_template_instance"
ADD COLUMN "sId" TEXT,
ADD COLUMN "status" "AgentInstanceStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- Generate sId for existing rows (use id as sId for existing records)
UPDATE "agent_template_instance" SET "sId" = "id" WHERE "sId" IS NULL;

-- Now make sId NOT NULL
ALTER TABLE "agent_template_instance" ALTER COLUMN "sId" SET NOT NULL;

-- Drop the isActive column (replaced by status)
ALTER TABLE "agent_template_instance" DROP COLUMN IF EXISTS "isActive";

-- AlterTable: Fix dynamic_agent_config defaults
ALTER TABLE "dynamic_agent_config"
ALTER COLUMN "enabledToolIds" DROP DEFAULT,
ALTER COLUMN "workspaceIds" DROP DEFAULT,
ALTER COLUMN "connectorIds" DROP DEFAULT,
ALTER COLUMN "delegatableAgentIds" DROP DEFAULT;

-- AlterTable: Fix dynamic_agent_execution
ALTER TABLE "dynamic_agent_execution"
ALTER COLUMN "conversationHistory" SET NOT NULL,
ALTER COLUMN "toolOutputRefs" DROP DEFAULT;

-- AlterTable: Fix mcp_tool_config
ALTER TABLE "mcp_tool_config" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable: agent_mcp_server_configuration
CREATE TABLE "agent_mcp_server_configuration" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "mcpConfigId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "integrationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dataSourceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tableIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "childAgentId" TEXT,
    "timeFrameDuration" INTEGER,
    "timeFrameUnit" TEXT,
    "jsonSchema" JSONB,
    "authLevel" TEXT NOT NULL DEFAULT 'medium',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_mcp_server_configuration_pkey" PRIMARY KEY ("id")
);

-- CreateTable: agent_integration_configuration
CREATE TABLE "agent_integration_configuration" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "integrationType" TEXT NOT NULL,
    "allowedResources" JSONB,
    "timeFrameDuration" INTEGER,
    "timeFrameUnit" TEXT,
    "accessLevel" TEXT NOT NULL DEFAULT 'read',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_integration_configuration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: agent_mcp_server_configuration indexes
CREATE INDEX "agent_mcp_server_configuration_instanceId_idx" ON "agent_mcp_server_configuration"("instanceId");
CREATE INDEX "agent_mcp_server_configuration_mcpConfigId_idx" ON "agent_mcp_server_configuration"("mcpConfigId");
CREATE UNIQUE INDEX "agent_mcp_server_configuration_instanceId_mcpConfigId_key" ON "agent_mcp_server_configuration"("instanceId", "mcpConfigId");

-- CreateIndex: agent_integration_configuration indexes
CREATE INDEX "agent_integration_configuration_instanceId_idx" ON "agent_integration_configuration"("instanceId");
CREATE INDEX "agent_integration_configuration_integrationId_idx" ON "agent_integration_configuration"("integrationId");
CREATE INDEX "agent_integration_configuration_integrationType_idx" ON "agent_integration_configuration"("integrationType");
CREATE UNIQUE INDEX "agent_integration_configuration_instanceId_integrationId_key" ON "agent_integration_configuration"("instanceId", "integrationId");

-- CreateIndex: agent_template_instance versioning indexes
CREATE INDEX "agent_template_instance_sId_idx" ON "agent_template_instance"("sId");
CREATE INDEX "agent_template_instance_status_idx" ON "agent_template_instance"("status");
CREATE UNIQUE INDEX "agent_template_instance_sId_version_key" ON "agent_template_instance"("sId", "version");

-- AddForeignKey: agent_mcp_server_configuration
ALTER TABLE "agent_mcp_server_configuration" ADD CONSTRAINT "agent_mcp_server_configuration_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "agent_template_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_mcp_server_configuration" ADD CONSTRAINT "agent_mcp_server_configuration_mcpConfigId_fkey" FOREIGN KEY ("mcpConfigId") REFERENCES "mcp_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: agent_integration_configuration
ALTER TABLE "agent_integration_configuration" ADD CONSTRAINT "agent_integration_configuration_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "agent_template_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_integration_configuration" ADD CONSTRAINT "agent_integration_configuration_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "workflow_integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
