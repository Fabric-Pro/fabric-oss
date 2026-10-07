-- Backfill `mcp_config."oauthBinding"` for the OAuth credentials whose
-- authorization server is PROVEN, and send every other credential-holding
-- OAuth config back through reconnect.
--
-- A binding is written only for a config that holds a token, belongs to a
-- system-provided server, and whose grant-time token endpoint is the one
-- allowlisted below for that server's key. The grant-time endpoint is the one
-- the callback exchanged the code at: the catalog's `oauthTokenEndpoint` for
-- github-remote (its configs carry no discovered endpoint, or the same one),
-- the endpoint recorded in `oauthMetadataCache` (snake_case `token_endpoint`
-- or camelCase `tokenEndpoint`) for the discovered ones. A cache entry is
-- never trusted on its own: only an exact allowlisted endpoint for that
-- server key binds, and its age does not matter. The two Atlassian hosts are
-- distinct authorization servers; each config keeps its own.
--
-- Allowlist, checked on 2026-10-06 against the catalog seed
-- (prisma/seed-enterprise-mcp.ts, prisma/seed.ts) and the servers' published
-- metadata:
--   github-remote  https://github.com/login/oauth/access_token  (catalog; AS https://github.com/login/oauth)
--   notion-remote  https://mcp.notion.com/token                 (AS https://mcp.notion.com)
--   atlassian      https://cf.mcp.atlassian.com/v1/token        (AS https://cf.mcp.atlassian.com)
--   atlassian      https://mcp.atlassian.com/v1/token           (AS https://mcp.atlassian.com)
--   google-drive   https://oauth2.googleapis.com/token          (AS https://accounts.google.com)
--
-- The binding's metadata is the validated subset of what the cache holds,
-- with `token_endpoint` forced to the allowlisted value.
--
-- Each binding also carries `credentialFingerprint`, computed in the SAME
-- UPDATE that writes it, from the very row values the binding is written
-- beside: a credential the previous app version writes afterwards (it writes
-- by id alone during the rolling deploy) no longer matches it, and is never
-- sent. It is the hex SHA-256 of
--   'v1' || '|' || f("oauthClientId")
--        || '|' || f("encryptedOauthClientSecret")
--        || '|' || f("encryptedRefreshToken")
-- where f(x) is '-' for NULL, else `<UTF-8 byte length>:<x>`: the encoding
-- `credentialFingerprint()` in prisma/queries/lib/mcp-oauth-binding.ts
-- computes. The migration test checks the two agree.
--
-- Evidence and credentials come from ONE row version. The "candidate" CTE
-- captures every column the evidence or the fingerprint reads (server, cache,
-- client id, secret, access and refresh token); the UPDATE fingerprints those
-- captured values and lands only while the row still holds exactly them and
-- is still unbound (null-safe IS NOT DISTINCT FROM). A write by the previous
-- app version that commits while this UPDATE waits for the row makes
-- Postgres re-check that WHERE against the new row version (READ COMMITTED),
-- which no longer matches: the row is skipped, stays unbound, and the second
-- statement flags it for reconnect.
--
-- migration-lint: allow unbatched-backfill — both UPDATEs touch only mcp_config rows that hold an OAuth token (26 on staging, 12 on prod, counted 2026-10-06); a batched job would leave those refresh tokens refreshable through discovery until it ran.

WITH "allowlist" ("serverKey", "tokenEndpoint", "authorizationServerUrl", "fromCatalog") AS (
  VALUES
    ('github-remote', 'https://github.com/login/oauth/access_token', 'https://github.com/login/oauth', true),
    ('notion-remote', 'https://mcp.notion.com/token', 'https://mcp.notion.com', false),
    ('atlassian', 'https://cf.mcp.atlassian.com/v1/token', 'https://cf.mcp.atlassian.com', false),
    ('atlassian', 'https://mcp.atlassian.com/v1/token', 'https://mcp.atlassian.com', false),
    ('google-drive', 'https://oauth2.googleapis.com/token', 'https://accounts.google.com', false)
),
"candidate" AS (
  SELECT c."id",
         c."mcpServerId",
         c."oauthClientId",
         c."encryptedOauthClientSecret",
         c."encryptedAccessToken",
         c."encryptedRefreshToken",
         s."key" AS "serverKey",
         s."oauthTokenEndpoint" AS "catalogTokenEndpoint",
         s."oauthAuthorizationEndpoint" AS "catalogAuthorizationEndpoint",
         c."oauthMetadataCache" AS "cache",
         NULLIF(
           COALESCE(
             c."oauthMetadataCache" ->> 'token_endpoint',
             c."oauthMetadataCache" ->> 'tokenEndpoint'
           ),
           ''
         ) AS "cachedTokenEndpoint"
    FROM "mcp_config" c
    JOIN "mcp_server" s ON s."id" = c."mcpServerId"
   WHERE s."isSystemProvided" = true
     AND c."oauthBinding" IS NULL
     AND (c."encryptedAccessToken" IS NOT NULL OR c."encryptedRefreshToken" IS NOT NULL)
),
"proven" AS (
  SELECT cand."id",
         cand."mcpServerId",
         cand."oauthClientId",
         cand."encryptedOauthClientSecret",
         cand."encryptedAccessToken",
         cand."encryptedRefreshToken",
         a."tokenEndpoint",
         a."authorizationServerUrl",
         a."fromCatalog",
         cand."cache",
         cand."catalogAuthorizationEndpoint"
    FROM "candidate" cand
    JOIN "allowlist" a ON a."serverKey" = cand."serverKey"
   WHERE (
           a."fromCatalog"
           AND cand."catalogTokenEndpoint" = a."tokenEndpoint"
           AND (cand."cachedTokenEndpoint" IS NULL OR cand."cachedTokenEndpoint" = a."tokenEndpoint")
         )
      OR (NOT a."fromCatalog" AND cand."cachedTokenEndpoint" = a."tokenEndpoint")
)
UPDATE "mcp_config" c
   SET "oauthBinding" = jsonb_build_object(
         'authorizationServerUrl', p."authorizationServerUrl",
         'tokenEndpoint', p."tokenEndpoint",
         'authorizationServerMetadata', jsonb_strip_nulls(jsonb_build_object(
           'issuer', p."cache" ->> 'issuer',
           'authorization_endpoint', COALESCE(
             p."cache" ->> 'authorization_endpoint',
             p."cache" ->> 'authorizationEndpoint',
             CASE WHEN p."fromCatalog" THEN p."catalogAuthorizationEndpoint" END
           ),
           'token_endpoint', p."tokenEndpoint",
           'registration_endpoint', COALESCE(
             p."cache" ->> 'registration_endpoint',
             p."cache" ->> 'registrationEndpoint'
           ),
           'response_types_supported', p."cache" -> 'response_types_supported',
           'code_challenge_methods_supported', COALESCE(
             p."cache" -> 'code_challenge_methods_supported',
             p."cache" -> 'codeChallengeMethodsSupported'
           ),
           'token_endpoint_auth_methods_supported', p."cache" -> 'token_endpoint_auth_methods_supported',
           'grant_types_supported', p."cache" -> 'grant_types_supported',
           'scopes_supported', COALESCE(
             p."cache" -> 'scopes_supported',
             p."cache" -> 'scopesSupported'
           )
         )),
         'source', 'backfill',
         'boundAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'credentialFingerprint', encode(
           sha256(convert_to(
             'v1'
             || '|' || CASE WHEN p."oauthClientId" IS NULL THEN '-'
                       ELSE octet_length(p."oauthClientId")::text || ':' || p."oauthClientId" END
             || '|' || CASE WHEN p."encryptedOauthClientSecret" IS NULL THEN '-'
                       ELSE octet_length(p."encryptedOauthClientSecret")::text || ':' || p."encryptedOauthClientSecret" END
             || '|' || CASE WHEN p."encryptedRefreshToken" IS NULL THEN '-'
                       ELSE octet_length(p."encryptedRefreshToken")::text || ':' || p."encryptedRefreshToken" END,
             'UTF8'
           )),
           'hex'
         )
       )
  FROM "proven" p
 WHERE c."id" = p."id"
   -- Still the row version the evidence and the fingerprint were taken from.
   AND c."oauthBinding" IS NULL
   AND c."mcpServerId" IS NOT DISTINCT FROM p."mcpServerId"
   AND c."oauthMetadataCache" IS NOT DISTINCT FROM p."cache"
   AND c."oauthClientId" IS NOT DISTINCT FROM p."oauthClientId"
   AND c."encryptedOauthClientSecret" IS NOT DISTINCT FROM p."encryptedOauthClientSecret"
   AND c."encryptedAccessToken" IS NOT DISTINCT FROM p."encryptedAccessToken"
   AND c."encryptedRefreshToken" IS NOT DISTINCT FROM p."encryptedRefreshToken";

-- Every other OAuth config that still holds a token stays unbound and is
-- marked for reconnect: an unbound credential is never refreshed, and the
-- connect flow binds the new grant. Configs on another auth type are left
-- alone (the reconnect flag would hide a working API key behind an OAuth flow
-- they no longer use).
UPDATE "mcp_config"
   SET "needsReauth" = true,
       "lastRefreshError" = 'Reconnect required: these OAuth credentials are not bound to a known authorization server.'
 WHERE "oauthBinding" IS NULL
   AND "authType" = 'OAUTH2'
   AND "needsReauth" = false
   AND ("encryptedAccessToken" IS NOT NULL OR "encryptedRefreshToken" IS NOT NULL);
