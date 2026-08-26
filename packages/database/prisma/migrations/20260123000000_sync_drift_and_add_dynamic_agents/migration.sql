-- Sync Drift and Add Dynamic Agents Phase 1
-- This migration:
-- 1. Syncs the schema drift (enum values, indexes that exist in DB but not in migrations)
-- 2. Adds new dynamic agent tables for visual agent builder

-- ============================================================
-- PART 1: SYNC EXISTING DRIFT
-- These items already exist in the database but aren't in migration history
-- ============================================================

-- Add missing enum values to AIProvider (already exist in DB)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'AZURE_OPENAI' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'AIProvider')) THEN
        ALTER TYPE "AIProvider" ADD VALUE 'AZURE_OPENAI';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'NETLIFY' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'AIProvider')) THEN
        ALTER TYPE "AIProvider" ADD VALUE 'NETLIFY';
    END IF;
END $$;

-- Add missing enum value to AgentFramework
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'MASTRA' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'AgentFramework')) THEN
        ALTER TYPE "AgentFramework" ADD VALUE 'MASTRA';
    END IF;
END $$;

-- Add missing enum value to WorkflowIntegrationProvider
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'MICROSOFT_GRAPH' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'WorkflowIntegrationProvider')) THEN
        ALTER TYPE "WorkflowIntegrationProvider" ADD VALUE 'MICROSOFT_GRAPH';
    END IF;
END $$;

-- Add missing column to ai_model table
ALTER TABLE "ai_model" ADD COLUMN IF NOT EXISTS "replacementModelId" TEXT;
CREATE INDEX IF NOT EXISTS "ai_model_replacementModelId_idx" ON "ai_model"("replacementModelId");
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_model_replacementModelId_fkey') THEN
        ALTER TABLE "ai_model" ADD CONSTRAINT "ai_model_replacementModelId_fkey"
            FOREIGN KEY ("replacementModelId") REFERENCES "ai_model"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- Add missing tenant indexes
CREATE INDEX IF NOT EXISTS "agent_organizationId_userId_idx" ON "agent"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "agent_workspace_file_organizationId_userId_idx" ON "agent_workspace_file"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "ai_chat_organizationId_userId_idx" ON "ai_chat"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "ai_usage_log_organizationId_userId_idx" ON "ai_usage_log"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "mcp_config_organizationId_userId_idx" ON "mcp_config"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "mcp_server_organizationId_userId_isSystemProvided_idx" ON "mcp_server"("organizationId", "userId", "isSystemProvided");
CREATE INDEX IF NOT EXISTS "project_organizationId_userId_idx" ON "project"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "purchase_organizationId_userId_idx" ON "purchase"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "wizard_temp_context_organizationId_userId_idx" ON "wizard_temp_context"("organizationId", "userId");

-- Drop old project index if it exists (was renamed)
DROP INDEX IF EXISTS "project_projectManagementMcpServerId_idx";

-- ============================================================
-- PART 2: NEW ENUMS FOR DYNAMIC AGENTS
-- ============================================================

-- Create DynamicAgentStatus enum
CREATE TYPE "DynamicAgentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED', 'DEPRECATED');

-- Create DynamicAgentTriggerType enum
CREATE TYPE "DynamicAgentTriggerType" AS ENUM ('MANUAL', 'SCHEDULED', 'WEBHOOK', 'EVENT', 'MENTION');

-- Create DynamicAgentExecutionStatus enum
CREATE TYPE "DynamicAgentExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT');

-- ============================================================
-- PART 3: NEW TABLES FOR DYNAMIC AGENTS
-- ============================================================

-- OffloadedToolOutput - Store large tool outputs to reduce context
CREATE TABLE "offloaded_tool_output" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "fullOutput" TEXT NOT NULL,
    "outputSizeBytes" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offloaded_tool_output_pkey" PRIMARY KEY ("id")
);

-- Indexes for offloaded_tool_output
CREATE INDEX "offloaded_tool_output_executionId_idx" ON "offloaded_tool_output"("executionId");
CREATE INDEX "offloaded_tool_output_contentHash_idx" ON "offloaded_tool_output"("contentHash");
CREATE INDEX "offloaded_tool_output_expiresAt_idx" ON "offloaded_tool_output"("expiresAt");
CREATE INDEX "offloaded_tool_output_userId_idx" ON "offloaded_tool_output"("userId");
CREATE INDEX "offloaded_tool_output_organizationId_idx" ON "offloaded_tool_output"("organizationId");

-- Foreign keys for offloaded_tool_output
ALTER TABLE "offloaded_tool_output" ADD CONSTRAINT "offloaded_tool_output_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offloaded_tool_output" ADD CONSTRAINT "offloaded_tool_output_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DynamicAgentConfig - User-created dynamic agents
CREATE TABLE "dynamic_agent_config" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "avatarUrl" TEXT,
    "userId" TEXT,
    "organizationId" TEXT,
    "scope" "AgentScope" NOT NULL DEFAULT 'USER',
    "systemPrompt" TEXT NOT NULL,
    "instructionSections" JSONB NOT NULL DEFAULT '[]',
    "enabledToolIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "workspaceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connectorIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "canDelegateToAgents" BOOLEAN NOT NULL DEFAULT false,
    "delegatableAgentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxRecursionDepth" INTEGER NOT NULL DEFAULT 4,
    "aiModel" TEXT,
    "aiProvider" TEXT,
    "temperature" DOUBLE PRECISION,
    "maxIterations" INTEGER NOT NULL DEFAULT 50,
    "maxTokensPerTurn" INTEGER NOT NULL DEFAULT 8000,
    "timeoutMs" INTEGER NOT NULL DEFAULT 1800000,
    "version" INTEGER NOT NULL DEFAULT 1,
    "versionNotes" TEXT,
    "previousVersionId" TEXT,
    "status" "DynamicAgentStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "dynamic_agent_config_pkey" PRIMARY KEY ("id")
);

-- Indexes for dynamic_agent_config
CREATE UNIQUE INDEX "dynamic_agent_config_name_userId_organizationId_key" ON "dynamic_agent_config"("name", "userId", "organizationId");
CREATE INDEX "dynamic_agent_config_userId_idx" ON "dynamic_agent_config"("userId");
CREATE INDEX "dynamic_agent_config_organizationId_idx" ON "dynamic_agent_config"("organizationId");
CREATE INDEX "dynamic_agent_config_status_idx" ON "dynamic_agent_config"("status");

-- Foreign keys for dynamic_agent_config
ALTER TABLE "dynamic_agent_config" ADD CONSTRAINT "dynamic_agent_config_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dynamic_agent_config" ADD CONSTRAINT "dynamic_agent_config_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DynamicAgentTrigger - Automated triggers for agents
CREATE TABLE "dynamic_agent_trigger" (
    "id" TEXT NOT NULL,
    "agentConfigId" TEXT NOT NULL,
    "type" "DynamicAgentTriggerType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "schedule" TEXT,
    "timezone" TEXT DEFAULT 'UTC',
    "webhookSecret" TEXT,
    "eventType" TEXT,
    "eventFilter" JSONB,
    "inputTemplate" JSONB,
    "lastTriggeredAt" TIMESTAMP(3),
    "nextScheduledAt" TIMESTAMP(3),
    "triggerCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dynamic_agent_trigger_pkey" PRIMARY KEY ("id")
);

-- Indexes for dynamic_agent_trigger
CREATE INDEX "dynamic_agent_trigger_agentConfigId_idx" ON "dynamic_agent_trigger"("agentConfigId");
CREATE INDEX "dynamic_agent_trigger_type_idx" ON "dynamic_agent_trigger"("type");
CREATE INDEX "dynamic_agent_trigger_isEnabled_idx" ON "dynamic_agent_trigger"("isEnabled");
CREATE INDEX "dynamic_agent_trigger_nextScheduledAt_idx" ON "dynamic_agent_trigger"("nextScheduledAt");

-- Foreign keys for dynamic_agent_trigger
ALTER TABLE "dynamic_agent_trigger" ADD CONSTRAINT "dynamic_agent_trigger_agentConfigId_fkey"
    FOREIGN KEY ("agentConfigId") REFERENCES "dynamic_agent_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DynamicAgentExecution - Track agent executions
CREATE TABLE "dynamic_agent_execution" (
    "id" TEXT NOT NULL,
    "agentConfigId" TEXT NOT NULL,
    "triggerId" TEXT,
    "temporalWorkflowId" TEXT,
    "temporalRunId" TEXT,
    "userId" TEXT,
    "organizationId" TEXT,
    "status" "DynamicAgentExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "iterationCount" INTEGER NOT NULL DEFAULT 0,
    "totalTokensUsed" INTEGER NOT NULL DEFAULT 0,
    "totalToolCalls" INTEGER NOT NULL DEFAULT 0,
    "totalDelegations" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "conversationHistory" JSONB DEFAULT '[]',
    "toolOutputRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dynamic_agent_execution_pkey" PRIMARY KEY ("id")
);

-- Indexes for dynamic_agent_execution
CREATE INDEX "dynamic_agent_execution_agentConfigId_idx" ON "dynamic_agent_execution"("agentConfigId");
CREATE INDEX "dynamic_agent_execution_triggerId_idx" ON "dynamic_agent_execution"("triggerId");
CREATE INDEX "dynamic_agent_execution_temporalWorkflowId_idx" ON "dynamic_agent_execution"("temporalWorkflowId");
CREATE INDEX "dynamic_agent_execution_userId_idx" ON "dynamic_agent_execution"("userId");
CREATE INDEX "dynamic_agent_execution_organizationId_idx" ON "dynamic_agent_execution"("organizationId");
CREATE INDEX "dynamic_agent_execution_status_idx" ON "dynamic_agent_execution"("status");
CREATE INDEX "dynamic_agent_execution_createdAt_idx" ON "dynamic_agent_execution"("createdAt");

-- Foreign keys for dynamic_agent_execution
ALTER TABLE "dynamic_agent_execution" ADD CONSTRAINT "dynamic_agent_execution_agentConfigId_fkey"
    FOREIGN KEY ("agentConfigId") REFERENCES "dynamic_agent_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dynamic_agent_execution" ADD CONSTRAINT "dynamic_agent_execution_triggerId_fkey"
    FOREIGN KEY ("triggerId") REFERENCES "dynamic_agent_trigger"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "dynamic_agent_execution" ADD CONSTRAINT "dynamic_agent_execution_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dynamic_agent_execution" ADD CONSTRAINT "dynamic_agent_execution_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DynamicAgentFavorite - User favorites for agents
CREATE TABLE "dynamic_agent_favorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentConfigId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dynamic_agent_favorite_pkey" PRIMARY KEY ("id")
);

-- Indexes for dynamic_agent_favorite
CREATE UNIQUE INDEX "dynamic_agent_favorite_userId_agentConfigId_key" ON "dynamic_agent_favorite"("userId", "agentConfigId");
CREATE INDEX "dynamic_agent_favorite_userId_idx" ON "dynamic_agent_favorite"("userId");
CREATE INDEX "dynamic_agent_favorite_agentConfigId_idx" ON "dynamic_agent_favorite"("agentConfigId");

-- Foreign keys for dynamic_agent_favorite
ALTER TABLE "dynamic_agent_favorite" ADD CONSTRAINT "dynamic_agent_favorite_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dynamic_agent_favorite" ADD CONSTRAINT "dynamic_agent_favorite_agentConfigId_fkey"
    FOREIGN KEY ("agentConfigId") REFERENCES "dynamic_agent_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;
