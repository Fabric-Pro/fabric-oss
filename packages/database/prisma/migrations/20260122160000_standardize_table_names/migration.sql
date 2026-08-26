-- Standardize Table Names Migration
-- Renames PascalCase and camelCase tables to snake_case for consistency.
-- All other tables in the schema use snake_case via @@map() directives.

-- ============================================================
-- 1. Rename MCP-related tables from PascalCase to snake_case
-- ============================================================

-- MCPServer → mcp_server
ALTER TABLE "MCPServer" RENAME TO "mcp_server";

-- MCPConfig → mcp_config
ALTER TABLE "MCPConfig" RENAME TO "mcp_config";

-- MCPOAuthState → mcp_oauth_state
ALTER TABLE "MCPOAuthState" RENAME TO "mcp_oauth_state";

-- MCPClientSession → mcp_client_session
ALTER TABLE "MCPClientSession" RENAME TO "mcp_client_session";

-- ============================================================
-- 2. Rename twoFactor from camelCase to snake_case
-- ============================================================

-- twoFactor → two_factor
ALTER TABLE "twoFactor" RENAME TO "two_factor";

-- ============================================================
-- 3. Rename indexes for consistency (optional but cleaner)
-- Note: Indexes continue to work with old names, but renaming
-- makes the database schema cleaner and matches Prisma conventions.
-- ============================================================

-- MCPServer indexes → mcp_server
ALTER INDEX IF EXISTS "MCPServer_userId_idx" RENAME TO "mcp_server_userId_idx";
ALTER INDEX IF EXISTS "MCPServer_organizationId_idx" RENAME TO "mcp_server_organizationId_idx";
ALTER INDEX IF EXISTS "MCPServer_key_isSystemProvided_userId_organizationId_key" RENAME TO "mcp_server_key_isSystemProvided_userId_organizationId_key";

-- MCPConfig indexes → mcp_config
ALTER INDEX IF EXISTS "MCPConfig_userId_idx" RENAME TO "mcp_config_userId_idx";
ALTER INDEX IF EXISTS "MCPConfig_organizationId_idx" RENAME TO "mcp_config_organizationId_idx";
ALTER INDEX IF EXISTS "idx_mcp_config_user_org_status" RENAME TO "mcp_config_userId_organizationId_status_idx";
ALTER INDEX IF EXISTS "MCPConfig_mcpServerId_userId_organizationId_key" RENAME TO "mcp_config_mcpServerId_userId_organizationId_key";

-- MCPOAuthState indexes → mcp_oauth_state
ALTER INDEX IF EXISTS "MCPOAuthState_state_key" RENAME TO "mcp_oauth_state_state_key";
ALTER INDEX IF EXISTS "MCPOAuthState_userId_idx" RENAME TO "mcp_oauth_state_userId_idx";
ALTER INDEX IF EXISTS "MCPOAuthState_organizationId_idx" RENAME TO "mcp_oauth_state_organizationId_idx";
ALTER INDEX IF EXISTS "MCPOAuthState_expiresAt_idx" RENAME TO "mcp_oauth_state_expiresAt_idx";

-- MCPClientSession indexes → mcp_client_session
ALTER INDEX IF EXISTS "MCPClientSession_token_key" RENAME TO "mcp_client_session_token_key";
ALTER INDEX IF EXISTS "MCPClientSession_configId_idx" RENAME TO "mcp_client_session_configId_idx";
ALTER INDEX IF EXISTS "MCPClientSession_userId_idx" RENAME TO "mcp_client_session_userId_idx";
ALTER INDEX IF EXISTS "MCPClientSession_organizationId_idx" RENAME TO "mcp_client_session_organizationId_idx";

-- twoFactor primary key → two_factor
ALTER INDEX IF EXISTS "twoFactor_pkey" RENAME TO "two_factor_pkey";

-- ============================================================
-- 4. Rename foreign key constraints for consistency
-- ============================================================

-- MCPServer constraints
ALTER TABLE "mcp_server" RENAME CONSTRAINT "MCPServer_createdById_fkey" TO "mcp_server_createdById_fkey";
ALTER TABLE "mcp_server" RENAME CONSTRAINT "MCPServer_organizationId_fkey" TO "mcp_server_organizationId_fkey";
ALTER TABLE "mcp_server" RENAME CONSTRAINT "MCPServer_userId_fkey" TO "mcp_server_userId_fkey";

-- MCPConfig constraints
ALTER TABLE "mcp_config" RENAME CONSTRAINT "MCPConfig_mcpServerId_fkey" TO "mcp_config_mcpServerId_fkey";
ALTER TABLE "mcp_config" RENAME CONSTRAINT "MCPConfig_organizationId_fkey" TO "mcp_config_organizationId_fkey";
ALTER TABLE "mcp_config" RENAME CONSTRAINT "MCPConfig_userId_fkey" TO "mcp_config_userId_fkey";

-- MCPOAuthState constraints
ALTER TABLE "mcp_oauth_state" RENAME CONSTRAINT "MCPOAuthState_configId_fkey" TO "mcp_oauth_state_configId_fkey";
ALTER TABLE "mcp_oauth_state" RENAME CONSTRAINT "MCPOAuthState_mcpServerId_fkey" TO "mcp_oauth_state_mcpServerId_fkey";

-- MCPClientSession constraints
ALTER TABLE "mcp_client_session" RENAME CONSTRAINT "MCPClientSession_configId_fkey" TO "mcp_client_session_configId_fkey";

-- twoFactor constraints
ALTER TABLE "two_factor" RENAME CONSTRAINT "twoFactor_userId_fkey" TO "two_factor_userId_fkey";

-- ============================================================
-- 5. Rename primary key indexes
-- ============================================================

ALTER INDEX IF EXISTS "MCPServer_pkey" RENAME TO "mcp_server_pkey";
ALTER INDEX IF EXISTS "MCPConfig_pkey" RENAME TO "mcp_config_pkey";
ALTER INDEX IF EXISTS "MCPOAuthState_pkey" RENAME TO "mcp_oauth_state_pkey";
ALTER INDEX IF EXISTS "MCPClientSession_pkey" RENAME TO "mcp_client_session_pkey";

-- ============================================================
-- 6. Clean up any extra indexes that may exist from db push
-- ============================================================

DROP INDEX IF EXISTS "MCPConfig_organizationId_userId_idx";
DROP INDEX IF EXISTS "MCPServer_organizationId_userId_isSystemProvided_idx";
