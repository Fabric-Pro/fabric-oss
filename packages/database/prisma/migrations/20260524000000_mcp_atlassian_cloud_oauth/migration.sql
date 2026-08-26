-- AlterTable: Add Hybrid Atlassian Cloud OAuth fields to MCPConfig
-- These columns store a SECONDARY OAuth token (audience = api.atlassian.com)
-- chained off the primary Rovo MCP OAuth (audience = mcp.atlassian.com).
-- The secondary token is what unlocks REST attachment upload + site-direct
-- attachment URL rewriting for Jira push.
--
-- All columns are OPTIONAL / nullable so existing rows continue to work
-- unchanged — the PM-sync image-upload path gracefully degrades to base64
-- inline when the Cloud token is absent, expired, or refresh-failing.
ALTER TABLE "mcp_config"
  ADD COLUMN "encryptedAtlassianCloudAccessToken"  TEXT,
  ADD COLUMN "encryptedAtlassianCloudRefreshToken" TEXT,
  ADD COLUMN "atlassianCloudTokenExpiresAt"        TIMESTAMP(3),
  ADD COLUMN "atlassianCloudSiteUrl"               TEXT,
  ADD COLUMN "atlassianCloudCloudId"               TEXT,
  ADD COLUMN "atlassianCloudScopes"                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "atlassianCloudConnectedAt"           TIMESTAMP(3),
  ADD COLUMN "atlassianCloudRefreshFailureCount"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "atlassianCloudLastRefreshFailedAt"   TIMESTAMP(3),
  ADD COLUMN "atlassianCloudLastRefreshError"      TEXT;
