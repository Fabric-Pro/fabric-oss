-- Add projectManagementMcpServerId column to project table
-- This is part of the security fix: each user should use their own MCP config credentials
-- The old projectManagementMcpConfigId is deprecated and will be migrated

-- Add the new column
ALTER TABLE "project" ADD COLUMN "projectManagementMcpServerId" TEXT;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS "project_projectManagementMcpServerId_idx" ON "project"("projectManagementMcpServerId");

-- Data Migration: Copy mcpServerId from MCPConfig to Project
-- This migrates existing projects from storing configId to serverId
-- SECURITY FIX: After this, each user will need their own MCP connection to sync
UPDATE "project" p
SET "projectManagementMcpServerId" = c."mcpServerId"
FROM "MCPConfig" c
WHERE p."projectManagementMcpConfigId" = c."id"
  AND p."projectManagementMcpServerId" IS NULL
  AND p."projectManagementMcpConfigId" IS NOT NULL;
