-- Add MCP Tool Stake Levels (tiered approval system)
-- This migration adds:
-- 1. requiredMcpServers column to agent_template
-- 2. StakeLevel enum
-- 3. mcp_tool_config table for per-tool stake level configuration
-- 4. mcp_tool_approval table for tracking approved agent+tool+target combinations

-- Add requiredMcpServers to agent_template
ALTER TABLE "agent_template" ADD COLUMN IF NOT EXISTS "requiredMcpServers" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Create StakeLevel enum
DO $$ BEGIN
    CREATE TYPE "StakeLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create mcp_tool_config table
CREATE TABLE IF NOT EXISTS "mcp_tool_config" (
    "id" TEXT NOT NULL,
    "mcpConfigId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "stakeLevel" "StakeLevel" NOT NULL DEFAULT 'MEDIUM',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "customConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_tool_config_pkey" PRIMARY KEY ("id")
);

-- Create mcp_tool_approval table
CREATE TABLE IF NOT EXISTS "mcp_tool_approval" (
    "id" TEXT NOT NULL,
    "toolConfigId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "targetHash" TEXT NOT NULL,
    "targetDisplay" TEXT,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "mcp_tool_approval_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint for mcp_tool_config
DO $$ BEGIN
    ALTER TABLE "mcp_tool_config" ADD CONSTRAINT "mcp_tool_config_mcpConfigId_toolName_key" UNIQUE ("mcpConfigId", "toolName");
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create unique constraint for mcp_tool_approval
DO $$ BEGIN
    ALTER TABLE "mcp_tool_approval" ADD CONSTRAINT "mcp_tool_approval_toolConfigId_instanceId_targetHash_key" UNIQUE ("toolConfigId", "instanceId", "targetHash");
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create indexes for mcp_tool_config
CREATE INDEX IF NOT EXISTS "mcp_tool_config_mcpConfigId_idx" ON "mcp_tool_config"("mcpConfigId");

-- Create indexes for mcp_tool_approval
CREATE INDEX IF NOT EXISTS "mcp_tool_approval_toolConfigId_idx" ON "mcp_tool_approval"("toolConfigId");
CREATE INDEX IF NOT EXISTS "mcp_tool_approval_instanceId_idx" ON "mcp_tool_approval"("instanceId");
CREATE INDEX IF NOT EXISTS "mcp_tool_approval_approvedBy_idx" ON "mcp_tool_approval"("approvedBy");

-- Add foreign key constraints
DO $$ BEGIN
    ALTER TABLE "mcp_tool_config" ADD CONSTRAINT "mcp_tool_config_mcpConfigId_fkey" FOREIGN KEY ("mcpConfigId") REFERENCES "mcp_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "mcp_tool_approval" ADD CONSTRAINT "mcp_tool_approval_toolConfigId_fkey" FOREIGN KEY ("toolConfigId") REFERENCES "mcp_tool_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "mcp_tool_approval" ADD CONSTRAINT "mcp_tool_approval_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "agent_template_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
