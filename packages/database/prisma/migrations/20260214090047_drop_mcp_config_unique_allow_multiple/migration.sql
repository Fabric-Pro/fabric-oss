-- DropIndex
DROP INDEX "public"."mcp_config_mcpServerId_userId_organizationId_key";

-- CreateIndex
CREATE INDEX "mcp_config_mcpServerId_userId_organizationId_idx" ON "mcp_config"("mcpServerId", "userId", "organizationId");
