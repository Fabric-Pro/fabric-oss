-- Cursor registers the native callback cursor://anysphere.cursor-mcp/oauth/callback,
-- which predates RFC 8252 reverse-domain naming.
--
-- The installer (scripts/backfill-better-auth-1-7.ts) creates
-- fabric_oauth_client_compatibility() as whichever role runs it, so a migration
-- cannot replace it: only its owner may (staging refused this migration's first
-- version with "must be owner of function"). The migration role owns
-- oauth_client, and a table's owner may replace a trigger on it. So this creates
-- its own copy of the function, with the same body as the installer's, and
-- re-points the installed trigger to it under the same name and enabled state
-- that fabric_oauth_1_7_ready() checks. Where the installer never ran, there is
-- no trigger to re-point and the function stays unused.

CREATE OR REPLACE FUNCTION fabric_oauth_client_compatibility_v2() RETURNS trigger AS $function$
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

DO $repoint$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'fabric_oauth_client_compatibility'
      AND tgrelid = to_regclass('oauth_client')
      AND NOT tgisinternal
  ) THEN
    DROP TRIGGER fabric_oauth_client_compatibility ON oauth_client;
    CREATE TRIGGER fabric_oauth_client_compatibility BEFORE INSERT OR UPDATE ON oauth_client
    FOR EACH ROW EXECUTE FUNCTION fabric_oauth_client_compatibility_v2();
  END IF;
END;
$repoint$;
