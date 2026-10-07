-- The provider preserves existing resource policies. Extend only the installed
-- default API policy; existing tokens, MCP policies and custom restrictions stay intact.
-- migration-lint: allow set-valued-backfill — OAuth resource policy has three canonical rows; this updates at most the one installed API resource under a short lock timeout.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $migration$
BEGIN
  IF to_regprocedure('fabric_oauth_1_7_ready(text[])') IS NOT NULL THEN
    UPDATE oauth_resource
    SET "allowedScopes" = array_append("allowedScopes", 'repositories:read')
    WHERE identifier ~ '^https?://[^/?#]+/api/v1$'
      AND fabric_oauth_1_7_ready(ARRAY[
        regexp_replace(identifier, '/api/v1$', '/api/mcp-gateway'),
        regexp_replace(identifier, '/api/v1$', '/api/mcp-gateway/'),
        identifier
      ])
      AND disabled IS NOT TRUE
      AND "allowedScopes" @> ARRAY['mcp:read', 'instructions:read', 'instructions:write', 'offline_access']::text[]
      AND "allowedScopes" <@ ARRAY['mcp:read', 'instructions:read', 'instructions:write', 'offline_access']::text[];
  END IF;
END;
$migration$;
