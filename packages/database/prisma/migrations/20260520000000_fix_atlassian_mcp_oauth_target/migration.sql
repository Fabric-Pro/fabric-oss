-- =============================================================================
-- fix_atlassian_mcp_oauth_target
-- =============================================================================
-- Re-targets the Atlassian MCP server registry from auth.atlassian.com (SSO)
-- to mcp.atlassian.com (Atlassian's own MCP authorization server) so OAuth DCR
-- registers against cf.mcp.atlassian.com/v1/register and Atlassian's consent
-- screen recognizes Fabric. Also flips /v1/sse -> /v1/mcp HTTP (Atlassian
-- deprecates /v1/sse 2026-06-30).
--
-- Three idempotent operations:
--   1. UPDATE mcp_server  - re-target the system registry row
--   2. DELETE mcp_oauth_state - revoke in-flight states for pre-fix configs
--   3. UPDATE mcp_config  - clear stale credentials on pre-fix configs
--
-- Re-running is a no-op. Every WHERE clause is filtered by pre-fix-shape
-- predicates so post-fix configs never match.
--
-- Mirrors packages/database/scripts/2026-05-19-fix-atlassian-mcp-configs.ts
-- which remains available for operator-driven re-runs (e.g. if a future
-- deploy bypasses this migration).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Re-target the Atlassian MCP server registry row. Idempotent: setting
--    the same values on every re-run produces zero downstream effects.
-- -----------------------------------------------------------------------------
UPDATE "mcp_server"
SET
  "name"              = 'Atlassian (Jira, Confluence & Bitbucket)',
  "description"       = 'Connect to Jira for issue tracking, Confluence for documentation, and Bitbucket Cloud for repositories via Atlassian''s official Rovo MCP server. One OAuth connection unlocks all three; Bitbucket OAuth on Rovo arrives once Atlassian ships it.',
  "defaultUrl"        = 'https://mcp.atlassian.com/v1/mcp',
  "transport"         = 'HTTP'::"MCPTransport",
  "oauthDiscoveryUrl" = 'https://mcp.atlassian.com/.well-known/oauth-authorization-server',
  "tags"              = ARRAY['jira','confluence','bitbucket','issues','docs','code','enterprise','project-management','wiki']::TEXT[]
WHERE "key" = 'atlassian'
  AND "isSystemProvided" = true;

-- -----------------------------------------------------------------------------
-- 2. Revoke in-flight OAuth state rows for pre-fix configs. Runs BEFORE the
--    config UPDATE so the pre-fix-shape filter still matches. Any user
--    mid-OAuth re-issues fresh state on next attempt (state TTL is 10 min).
-- -----------------------------------------------------------------------------
DELETE FROM "mcp_oauth_state"
WHERE "configId" IN (
  SELECT c.id
  FROM "mcp_config" c
  WHERE c."mcpServerId" = (
          SELECT id FROM "mcp_server"
          WHERE "key" = 'atlassian' AND "isSystemProvided" = true LIMIT 1
        )
    AND (
      c."baseUrl" = 'https://mcp.atlassian.com/v1/sse'
      OR (
        c."dcrRegistrationEndpoint" IS NOT NULL
        AND c."dcrRegistrationEndpoint" <> 'https://cf.mcp.atlassian.com/v1/register'
      )
    )
);

-- -----------------------------------------------------------------------------
-- 3. Clear stale credentials on pre-fix MCPConfig rows. Filter matches only
--    rows whose baseUrl is the deprecated /v1/sse OR whose DCR registration
--    endpoint is non-null and not the post-fix cf.mcp.atlassian.com/v1/register.
--    Post-fix rows (issued by the new authorization server) do NOT match -
--    safe to re-run after users have already reconnected.
--
--    Access/refresh tokens are deliberately preserved. Any token issued by the
--    wrong auth server will 401 on use and the existing lastRefreshError /
--    needsReauth machinery surfaces the "Reconnect" prompt naturally.
-- -----------------------------------------------------------------------------
UPDATE "mcp_config"
SET
  "baseUrl"                    = NULL,
  "oauthClientId"              = NULL,
  "encryptedOauthClientSecret" = NULL,
  "dcrRegistrationEndpoint"    = NULL,
  "dcrClientMetadata"          = NULL,
  "dcrRegisteredAt"            = NULL,
  "oauthMetadataCache"         = NULL,
  "oauthMetadataCachedAt"      = NULL,
  "updatedAt"                  = NOW()
WHERE "mcpServerId" = (
        SELECT id FROM "mcp_server"
        WHERE "key" = 'atlassian' AND "isSystemProvided" = true LIMIT 1
      )
  AND (
    "baseUrl" = 'https://mcp.atlassian.com/v1/sse'
    OR (
      "dcrRegistrationEndpoint" IS NOT NULL
      AND "dcrRegistrationEndpoint" <> 'https://cf.mcp.atlassian.com/v1/register'
    )
  );
