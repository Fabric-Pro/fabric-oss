-- Run through backfill-better-auth-1-7.ts after the additive schema migration.
-- The runner supplies this environment's three canonical resource identifiers.
-- Schema expansion alone stays compatible with 1.6. This separate transaction
-- installs the bridge and backfills under the same locks, leaving no write gap.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE oauth_client, oauth_access_token, oauth_refresh_token, oauth_consent IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION fabric_oauth_client_compatibility() RETURNS trigger AS $function$
DECLARE
  application_type text;
  redirect_uri text;
  loopback boolean;
  web_redirect boolean;
  private_redirect boolean;
  ipv6_host text;
BEGIN
  IF NEW."tokenEndpointAuthMethod" IS DISTINCT FROM 'none'
    OR NEW."clientSecret" IS NOT NULL OR NEW.public IS FALSE
    OR NEW."skipConsent" IS TRUE OR NEW."requirePKCE" IS FALSE
    OR NEW."clientDiscoveryId" IS NOT NULL
    OR NEW.jwks IS NOT NULL OR NEW."jwksUri" IS NOT NULL
    OR NEW."dpopBoundAccessTokens" IS TRUE
    OR COALESCE(cardinality(NEW."clientCredentialsScopes"), 0) <> 0
    OR NOT COALESCE(NEW."grantTypes" <@ ARRAY['authorization_code', 'refresh_token']::text[], true)
    OR NOT COALESCE(NEW."responseTypes" <@ ARRAY['code']::text[], true)
    OR COALESCE(cardinality(NEW."redirectUris"), 0) = 0 THEN
    RAISE EXCEPTION 'Unsupported OAuth client shape' USING ERRCODE = 'check_violation';
  END IF;
  application_type := COALESCE(NEW."applicationType", CASE NEW.type
    WHEN 'native' THEN 'native' WHEN 'user-agent-based' THEN 'web' END);
  IF application_type IS NULL AND NEW.type IS NULL THEN
    -- Old registrations omit type. HTTPS-only callbacks retain the public
    -- web default; loopback/private callbacks require a native client.
    IF NOT EXISTS (SELECT 1 FROM unnest(NEW."redirectUris") AS uri WHERE uri !~* '^https://') THEN
      application_type := 'web';
    ELSE
      application_type := 'native';
    END IF;
  END IF;
  IF application_type NOT IN ('native', 'web') OR application_type IS NULL
    OR (NEW.type IS NOT NULL AND NEW.type IS DISTINCT FROM CASE application_type WHEN 'native' THEN 'native' ELSE 'user-agent-based' END) THEN
    RAISE EXCEPTION 'Unsupported OAuth client shape' USING ERRCODE = 'check_violation';
  END IF;
  FOREACH redirect_uri IN ARRAY NEW."redirectUris" LOOP
    loopback := redirect_uri ~* '^http://(127[.]0[.]0[.]1|localhost|\[::1\])(:[0-9]{1,5})?([/?][^#]*)?$';
    web_redirect := redirect_uri ~* '^https://([^\[\]:@/?#[:space:]]+|\[[0-9a-f:.]+\])(:[0-9]{1,5})?([/?][^#]*)?$'
      AND redirect_uri !~* '^https://(localhost[.]*|127[.][0-9.]+)([:/?]|$)';
    ipv6_host := substring(redirect_uri FROM '(?i)^https://\[([0-9a-f:.]+)\]');
    IF ipv6_host IS NOT NULL THEN
      BEGIN
        -- inet checks IPv6 syntax and recognizes expanded loopback spelling.
        web_redirect := web_redirect AND ipv6_host::inet <> '::1'::inet;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Unsupported OAuth client shape' USING ERRCODE = 'check_violation';
      END;
    END IF;
    -- The exact callback is the allowlist in packages/auth/lib/oauth-registration-policy.ts.
    private_redirect := redirect_uri = 'cursor://anysphere.cursor-mcp/oauth/callback'
      OR redirect_uri ~ '^[A-Za-z]([A-Za-z0-9-]*[A-Za-z0-9])?([.][A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+:/([^/].*)?$';
    -- The authority patterns exclude credentials. An @ in a path or query
    -- is ordinary URI data and must not prevent a valid registration.
    IF redirect_uri IS NULL OR redirect_uri ~ '[[:space:]#\\]'
      OR (application_type = 'native' AND NOT (loopback OR web_redirect OR private_redirect))
      OR (application_type = 'web' AND NOT web_redirect) THEN
      RAISE EXCEPTION 'Unsupported OAuth client shape' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  NEW.public := true;
  NEW.type := CASE application_type WHEN 'native' THEN 'native' ELSE 'user-agent-based' END;
  NEW."applicationType" := application_type;
  RETURN NEW;
END;
$function$ LANGUAGE plpgsql;

-- Migration 20261007120000 creates a v2 copy of this function, owned by the
-- migration role. Where it exists the trigger runs it, so neither role needs to
-- replace a function the other owns; elsewhere the trigger runs this one.
DROP TRIGGER IF EXISTS fabric_oauth_client_compatibility ON oauth_client;
DO $install_trigger$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER fabric_oauth_client_compatibility BEFORE INSERT OR UPDATE ON oauth_client FOR EACH ROW EXECUTE FUNCTION %s()',
    CASE WHEN to_regprocedure('fabric_oauth_client_compatibility_v2()') IS NOT NULL
      THEN 'fabric_oauth_client_compatibility_v2'
      ELSE 'fabric_oauth_client_compatibility' END);
END;
$install_trigger$;
UPDATE oauth_client SET "applicationType" = "applicationType";

DO $install$
DECLARE
  audiences text[];
  definition text;
  table_name text;
BEGIN
  SELECT array_agg(value ORDER BY ordinal) INTO audiences
  FROM jsonb_array_elements_text(current_setting('app.oauth_upgrade_audiences')::jsonb) WITH ORDINALITY AS resource(value, ordinal);
  IF cardinality(audiences) IS DISTINCT FROM 3
    OR audiences[1] !~ '^https?://[^/?#]+/api/mcp-gateway$'
    OR audiences[2] IS DISTINCT FROM audiences[1] || '/'
    OR audiences[3] IS DISTINCT FROM regexp_replace(audiences[1], '/api/mcp-gateway$', '/api/v1') THEN
    RAISE EXCEPTION 'Supply the three canonical OAuth resource identifiers';
  END IF;
  -- quote_literal via format %L keeps URL values out of executable SQL.
  -- Old application connections need no new environment variable or setting.
  definition := format($body$
    CREATE OR REPLACE FUNCTION fabric_oauth_grant_resources() RETURNS trigger AS $grant$
    DECLARE
      audiences text[] := %L::text[];
      allowed text[];
    BEGIN
      IF NEW."referenceId" IS NULL OR NEW."referenceId" = '' THEN
        allowed := ARRAY[]::text[];
      ELSIF NEW."referenceId" ~ '^project:mcp:[A-Za-z0-9_-]{1,64}$' THEN
        allowed := ARRAY[audiences[1]];
      ELSIF NEW."referenceId" ~ '^project:api:[A-Za-z0-9_-]{1,64}$' THEN
        allowed := ARRAY[audiences[3]];
      ELSIF NEW."referenceId" LIKE 'project:%%' THEN
        RAISE EXCEPTION 'Unsupported OAuth grant reference' USING ERRCODE = 'check_violation';
      ELSE
        allowed := audiences;
      END IF;
      IF NEW.resources IS NULL THEN
        NEW.resources := allowed;
      ELSIF NOT NEW.resources <@ allowed OR array_position(NEW.resources, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'Unsupported OAuth grant resources' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $grant$ LANGUAGE plpgsql;
  $body$, audiences);
  EXECUTE definition;
  FOREACH table_name IN ARRAY ARRAY['oauth_access_token', 'oauth_refresh_token', 'oauth_consent'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fabric_oauth_grant_resources ON %I', table_name);
    EXECUTE format('CREATE TRIGGER fabric_oauth_grant_resources BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION fabric_oauth_grant_resources()', table_name);
    -- NULL identifies a pre-expansion row. Explicit new arrays never widen.
    EXECUTE format('UPDATE %I SET resources = resources WHERE resources IS NULL', table_name);
  END LOOP;

  EXECUTE format($body$
    CREATE OR REPLACE FUNCTION fabric_oauth_1_7_ready(expected_audiences text[]) RETURNS boolean AS $ready$
      SELECT expected_audiences = %L::text[]
        AND (SELECT count(*) = 4 FROM pg_trigger
          WHERE (tgname = 'fabric_oauth_client_compatibility' AND tgrelid = 'oauth_client'::regclass
            OR tgname = 'fabric_oauth_grant_resources' AND tgrelid IN ('oauth_access_token'::regclass, 'oauth_refresh_token'::regclass, 'oauth_consent'::regclass))
          AND tgenabled = 'O')
        AND NOT EXISTS (SELECT 1 FROM oauth_client WHERE
          "applicationType" IS NULL OR "applicationType" NOT IN ('native', 'web')
          OR public IS DISTINCT FROM true
          OR type IS DISTINCT FROM CASE "applicationType" WHEN 'native' THEN 'native' ELSE 'user-agent-based' END
          OR "tokenEndpointAuthMethod" IS DISTINCT FROM 'none'
          OR "clientSecret" IS NOT NULL OR "skipConsent" IS TRUE OR "requirePKCE" IS FALSE
          OR "clientDiscoveryId" IS NOT NULL OR jwks IS NOT NULL OR "jwksUri" IS NOT NULL
          OR "dpopBoundAccessTokens" IS TRUE OR COALESCE(cardinality("clientCredentialsScopes"), 0) <> 0
          OR NOT COALESCE("grantTypes" <@ ARRAY['authorization_code', 'refresh_token']::text[], true)
          OR NOT COALESCE("responseTypes" <@ ARRAY['code']::text[], true)
          OR COALESCE(cardinality("redirectUris"), 0) = 0)
        AND NOT EXISTS (SELECT 1 FROM (
          SELECT "referenceId", resources FROM oauth_access_token UNION ALL
          SELECT "referenceId", resources FROM oauth_refresh_token UNION ALL
          SELECT "referenceId", resources FROM oauth_consent
        ) grants WHERE resources IS NULL OR array_position(resources, NULL) IS NOT NULL
          OR ("referenceId" LIKE 'project:%%' AND "referenceId" !~ '^project:(mcp|api):[A-Za-z0-9_-]{1,64}$')
          OR NOT resources <@ CASE
            WHEN "referenceId" IS NULL OR "referenceId" = '' THEN ARRAY[]::text[]
            WHEN "referenceId" ~ '^project:mcp:' THEN ARRAY[(%L::text[])[1]]
            WHEN "referenceId" ~ '^project:api:' THEN ARRAY[(%L::text[])[3]]
            ELSE %L::text[] END);
    $ready$ LANGUAGE sql STABLE SET search_path TO %I, pg_temp;
  $body$, audiences, audiences, audiences, audiences, current_schema());

  -- Promotion jobs receive database credentials without the application URL.
  -- Delegate to the same verifier using the installer's explicit configuration.
  EXECUTE format($body$
    CREATE OR REPLACE FUNCTION fabric_oauth_1_7_ready() RETURNS boolean AS $ready$
      SELECT fabric_oauth_1_7_ready(%L::text[]);
    $ready$ LANGUAGE sql STABLE SET search_path TO %I, pg_temp;
  $body$, audiences, current_schema());
END;
$install$;
COMMIT;
