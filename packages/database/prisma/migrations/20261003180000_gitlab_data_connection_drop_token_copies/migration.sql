-- GitLab Data Connections stop holding credentials (data only, no schema change).
--
-- A GitLab sync now acts with the GitLab connection of the person who starts
-- it, read live from that person's own GitLab connection inside each sync
-- activity. The token copies a GitLab Data Connection used to carry are no
-- longer read by anything, and they never refreshed or revoked with the real
-- connection, so they are removed here:
--
--   - "accessToken", "refreshToken", "tokenExpiresAt": the copied OAuth token.
--   - "credentialId": an assigned reusable credential. The
--     "data_connection_credential" row itself is provider-agnostic and is left
--     in place; it is only unassigned from GitLab connections.
--   - "credentials": the whole JSON value, not selected keys. Rows written
--     since encryption at rest hold this column as one encrypted JSON string,
--     whose keys SQL cannot see, and older plaintext rows hold client-chosen
--     key names (OAuth "access_token" / "refresh_token" / "user_access_token",
--     API-key "accessToken" / "apiKey" / "token", ...). Nothing reads a GitLab
--     row's "credentials" any more, so clearing the value is the only way to
--     be sure no token is left in it.
--
-- "config" (the GitLab address and the project / issue / merge-request
-- selection), "status" and every other column are unchanged.
--
-- IDEMPOTENT: the WHERE clause matches only GitLab rows that still hold one of
-- these values, so a second apply updates nothing. Rows of every other
-- provider are untouched.
UPDATE "data_connection"
SET
    "accessToken" = NULL,
    "refreshToken" = NULL,
    "tokenExpiresAt" = NULL,
    "credentialId" = NULL,
    "credentials" = NULL
WHERE "provider" = 'GITLAB'
  AND (
    "accessToken" IS NOT NULL
    OR "refreshToken" IS NOT NULL
    OR "tokenExpiresAt" IS NOT NULL
    OR "credentialId" IS NOT NULL
    OR "credentials" IS NOT NULL
  );
