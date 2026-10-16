-- The provider preserves existing resource policies (resourceSeedMode insertOnly), so
-- the new memory:write scope reaches an installed deployment only through this update.
-- Extend only the installed default policies of the API and the MCP gateway; existing
-- tokens, custom restrictions and disabled resources stay intact.
-- migration-lint: allow set-valued-backfill — OAuth resource policy has three canonical rows; this updates at most those under a short lock timeout.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $migration$
BEGIN
  IF to_regprocedure('fabric_oauth_1_7_ready(text[])') IS NOT NULL THEN
    UPDATE oauth_resource
    SET "allowedScopes" = array_append("allowedScopes", 'memory:write')
    WHERE identifier ~ '^https?://[^/?#]+/api/(v1|mcp-gateway/?)$'
      AND fabric_oauth_1_7_ready(ARRAY[
        substring(identifier from '^https?://[^/?#]+') || '/api/mcp-gateway',
        substring(identifier from '^https?://[^/?#]+') || '/api/mcp-gateway/',
        substring(identifier from '^https?://[^/?#]+') || '/api/v1'
      ])
      AND disabled IS NOT TRUE
      AND NOT ("allowedScopes" @> ARRAY['memory:write']::text[])
      AND "allowedScopes" @> ARRAY['mcp:read', 'instructions:read', 'instructions:write', 'offline_access']::text[]
      AND "allowedScopes" <@ ARRAY['mcp:read', 'instructions:read', 'instructions:write', 'offline_access', 'repositories:read']::text[];
  END IF;
END;
$migration$;
