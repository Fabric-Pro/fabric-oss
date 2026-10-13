-- migration-lint: allow unbatched-backfill — only touches mcp_config rows for the one Atlassian server, a small count.
-- Mirrors wipeMcpOAuthTokensWhere({ clearBinding: true, clearClient: true }); system rows can't go through updateMcpServer.

-- 1. Update system server defaultUrl and oauthDiscoveryUrl to v2
UPDATE "mcp_server"
   SET "defaultUrl" = 'https://mcp.atlassian.com/v2/mcp?tools=all',
       "oauthDiscoveryUrl" = 'https://auth.atlassian.com/.well-known/oauth-authorization-server/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3'
 WHERE "key" = 'atlassian'
   AND "isSystemProvided" = true
   AND "userId" IS NULL
   AND "organizationId" IS NULL;

-- 2. Clear pending in-flight OAuth flow states
DELETE FROM "mcp_oauth_state"
 WHERE "configId" IN (
   SELECT c."id"
     FROM "mcp_config" c
     JOIN "mcp_server" s ON s."id" = c."mcpServerId"
    WHERE s."key" = 'atlassian'
      AND s."isSystemProvided" = true
      AND s."userId" IS NULL
      AND s."organizationId" IS NULL
 );

-- 3. Reset existing Atlassian configs:
--    - Configs with baseUrl IS NULL keep baseUrl as NULL (inheriting defaultUrl).
--    - Any unexpected custom baseUrl is preserved.
--    - Resets scopes = '{}' so new default scopes populate on reconnect.
--    - Leaves encryptedAtlassianCloud* token fields untouched (separate 3LO attachment auth).
UPDATE "mcp_config"
   SET "baseUrl" = CASE
         WHEN "baseUrl" LIKE 'https://mcp.atlassian.com/v1/%' THEN 'https://mcp.atlassian.com/v2/mcp?tools=all'
         ELSE "baseUrl"
       END,
       "scopes"                     = '{}',
       "oauthClientId"              = NULL,
       "encryptedOauthClientSecret" = NULL,
       "encryptedAccessToken"       = NULL,
       "accessTokenHash"            = NULL,
       "encryptedRefreshToken"      = NULL,
       "tokenExpiresAt"             = NULL,
       "oauthBinding"               = NULL,
       "oauthMetadataCache"         = NULL,
       "oauthMetadataCachedAt"      = NULL,
       "dcrRegistrationEndpoint"    = NULL,
       "dcrClientMetadata"          = NULL,
       "dcrRegisteredAt"            = NULL,
       "cachedTools"                = NULL,
       "toolsCachedAt"              = NULL,
       "toolCount"                  = 0,
       "oauthGrantGeneration"       = "oauthGrantGeneration" + 1,
       "needsReauth"                = true
 WHERE "mcpServerId" IN (
   SELECT s."id" FROM "mcp_server" s
    WHERE s."key" = 'atlassian'
      AND s."isSystemProvided" = true
      AND s."userId" IS NULL
      AND s."organizationId" IS NULL
 )
   AND "authType" = 'OAUTH2';
