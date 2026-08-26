-- Add cached tools columns to MCPConfig
ALTER TABLE "MCPConfig" ADD COLUMN IF NOT EXISTS "cachedTools" JSONB;
ALTER TABLE "MCPConfig" ADD COLUMN IF NOT EXISTS "toolsCachedAt" TIMESTAMP(3);
ALTER TABLE "MCPConfig" ADD COLUMN IF NOT EXISTS "toolCount" INTEGER NOT NULL DEFAULT 0;

-- Add indexes for tenant isolation queries
CREATE INDEX IF NOT EXISTS "MCPConfig_organizationId_userId_idx" ON "MCPConfig"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "MCPServer_organizationId_userId_isSystemProvided_idx" ON "MCPServer"("organizationId", "userId", "isSystemProvided");
CREATE INDEX IF NOT EXISTS "agent_organizationId_userId_idx" ON "agent"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "agent_workspace_file_organizationId_userId_idx" ON "agent_workspace_file"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "ai_chat_organizationId_userId_idx" ON "ai_chat"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "ai_usage_log_organizationId_userId_idx" ON "ai_usage_log"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "project_organizationId_userId_idx" ON "project"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "purchase_organizationId_userId_idx" ON "purchase"("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "wizard_temp_context_organizationId_userId_idx" ON "wizard_temp_context"("organizationId", "userId");
