-- =============================================================================
-- backfill_default_excalidraw_mcp_config
-- =============================================================================
-- This migration is one atomic file with four ordered phases:
--   1. Schema deltas      — Prisma-generated columns/index
--   2. Seed flip          — mark system `excalidraw` row as default-enabled
--   3. Backfill           — sentinel MCPConfig per personal + org tenant tuple
--   4. Dedupe             — repurpose pre-existing user-installed Excalidraw
--                           rows in place
--
-- Every data-write step is guarded so re-running the migration is a no-op
-- (zero new rows, zero updates on the second pass).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Schema deltas (Prisma-generated)
-- -----------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "mcp_config" ADD COLUMN     "isManagedDefault" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "mcp_server" ADD COLUMN     "defaultEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "eagerKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "eagerToolName" TEXT,
ADD COLUMN     "suppressOnEager" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex (partial — only over default-enabled rows; the set is tiny,
-- so partial-on-true makes lookups index seeks instead of sequential scans.)
CREATE INDEX "mcp_server_default_enabled_idx" ON "mcp_server"("defaultEnabled")
  WHERE "defaultEnabled" = true;

-- -----------------------------------------------------------------------------
-- 2. Seed flip — mark the system-provided excalidraw row default-enabled with
--    eager-routing fields populated. Idempotent: re-running sets the same
--    values.
-- -----------------------------------------------------------------------------

UPDATE "mcp_server"
SET
  "defaultEnabled"  = true,
  "eagerKeywords"   = ARRAY['excalidraw']::TEXT[],
  "eagerToolName"   = 'create_view',
  "suppressOnEager" = ARRAY['fabric_create_frame', 'fabric_create_slideshow']::TEXT[]
WHERE key = 'excalidraw'
  AND "isSystemProvided" = true;

-- -----------------------------------------------------------------------------
-- 3a. Backfill — personal contexts. One row per user that doesn't already
--     own one. gen_random_uuid()::text produces a UUID v4 string Prisma's
--     cuid() consumers accept transparently (id columns are TEXT). Same
--     pattern as 20260424220000_backfill_must_change_password_seeded_users.
--     Tenant XOR: userId NOT NULL + organizationId NULL (personal).
-- -----------------------------------------------------------------------------

INSERT INTO "mcp_config" (
  id, "mcpServerId", "userId", "organizationId",
  "authType", enabled, "isManagedDefault",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  (SELECT id FROM "mcp_server"
     WHERE key = 'excalidraw' AND "isSystemProvided" = true LIMIT 1),
  u.id,
  NULL,
  'NONE',
  true,
  true,
  NOW(),
  NOW()
FROM "user" u
WHERE EXISTS (
  -- Defense: skip backfill if the system excalidraw row hasn't been seeded
  -- yet (otherwise mcpServerId becomes NULL → NOT NULL violation).
  -- In CI/prod the seed runs before this migration; this guard makes the
  -- migration safe to apply to a fresh DB without seed data too.
  SELECT 1 FROM "mcp_server"
  WHERE key = 'excalidraw' AND "isSystemProvided" = true
)
AND NOT EXISTS (
  SELECT 1 FROM "mcp_config" c
  WHERE c."userId"         = u.id
    AND c."organizationId" IS NULL
    AND c."mcpServerId"    = (SELECT id FROM "mcp_server"
                              WHERE key = 'excalidraw' AND "isSystemProvided" = true LIMIT 1)
);

-- -----------------------------------------------------------------------------
-- 3b. Backfill — org contexts. One row per (user, organization) where a
--     Better Auth `member` row exists. Pending invitations are NOT pre-seeded;
--     invite-accept time is handled by the auth hook. Tenant XOR:
--     userId NOT NULL + organizationId NOT NULL (org context).
-- -----------------------------------------------------------------------------

INSERT INTO "mcp_config" (
  id, "mcpServerId", "userId", "organizationId",
  "authType", enabled, "isManagedDefault",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  (SELECT id FROM "mcp_server"
     WHERE key = 'excalidraw' AND "isSystemProvided" = true LIMIT 1),
  m."userId",
  m."organizationId",
  'NONE',
  true,
  true,
  NOW(),
  NOW()
FROM "member" m
WHERE EXISTS (
  -- Same defense as 3a — skip if the system excalidraw row hasn't been seeded.
  SELECT 1 FROM "mcp_server"
  WHERE key = 'excalidraw' AND "isSystemProvided" = true
)
AND NOT EXISTS (
  SELECT 1 FROM "mcp_config" c
  WHERE c."userId"         = m."userId"
    AND c."organizationId" = m."organizationId"
    AND c."mcpServerId"    = (SELECT id FROM "mcp_server"
                              WHERE key = 'excalidraw' AND "isSystemProvided" = true LIMIT 1)
);

-- -----------------------------------------------------------------------------
-- 4. Dedupe — repurpose any pre-existing user-installed Excalidraw rows
--    in place. Flip them to managed-default, ensure enabled, null any
--    encrypted credentials.
--
--    The dedupe is non-destructive: no `mcp_config` row is deleted, so every
--    `Diagram.mcpConfigId` reference stays valid (the FK is preserved because
--    the row id is preserved).
--
--    The auth-field nulling is safe because Excalidraw is `authMethods:
--    ["NONE"]` — there is no plaintext credential being thrown away that the
--    Excalidraw service expects. If a future default-enabled server requires
--    auth, that path MUST replace this step with a more careful strategy.
-- -----------------------------------------------------------------------------

UPDATE "mcp_config" c
SET
  "isManagedDefault"           = true,
  enabled                      = true,
  "authType"                   = 'NONE',
  "encryptedApiKey"            = NULL,
  "encryptedAccessToken"       = NULL,
  "encryptedRefreshToken"      = NULL,
  "encryptedOauthClientSecret" = NULL,
  "oauthClientId"              = NULL,
  "accessTokenHash"            = NULL,
  "needsReauth"                = false,
  "updatedAt"                  = NOW()
WHERE c."mcpServerId" = (
        SELECT id FROM "mcp_server"
        WHERE key = 'excalidraw' AND "isSystemProvided" = true LIMIT 1
      )
  AND c."isManagedDefault" = false;
