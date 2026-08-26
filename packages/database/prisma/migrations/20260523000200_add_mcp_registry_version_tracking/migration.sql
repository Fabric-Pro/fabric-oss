-- =============================================================================
-- add_mcp_registry_version_tracking
-- =============================================================================
-- Bug: The Redis cache for MCP system servers has a 7-day TTL and was hand-
-- versioned (`mcp:registry:system-servers:v2 → v3 → v4`) every time a migration
-- changed system server data. Raw SQL UPDATEs against `mcp_server` never
-- invalidated Redis, so deployed instances served stale base URLs / names /
-- descriptions for up to 7 days.
--
-- This migration installs a database-side version counter that any write to
-- `mcp_server` (Prisma, raw SQL, or manual edit) increments via trigger. The
-- API layer reads this counter and uses it as the Redis cache key suffix, so
-- the next request after a write naturally misses the cache and re-populates
-- from Postgres. No application-level discipline is required.
--
-- Idempotent — safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Singleton-row table holding the current registry version. The CHECK
--    constraint pins it to one row; the BIGINT counter handles ~9.2e18 bumps.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "mcp_registry_version" (
  "id"        INTEGER     PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "version"   BIGINT      NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

INSERT INTO "mcp_registry_version" ("id", "version")
VALUES (1, 1)
ON CONFLICT ("id") DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Statement-level trigger function. Statement-level (not row-level) keeps
--    bulk seeds cheap: 30 rows updated in one statement => 1 version bump.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bump_mcp_registry_version() RETURNS TRIGGER AS $$
BEGIN
  UPDATE "mcp_registry_version"
     SET "version"   = "version" + 1,
         "updatedAt" = NOW()
   WHERE "id" = 1;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- 3. Trigger on the `mcp_server` table. DROP IF EXISTS + CREATE keeps it
--    idempotent across re-runs and lets us safely tweak the function body
--    later without orphaning the trigger.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "mcp_server_bump_registry_version" ON "mcp_server";
CREATE TRIGGER "mcp_server_bump_registry_version"
  AFTER INSERT OR UPDATE OR DELETE ON "mcp_server"
  FOR EACH STATEMENT
  EXECUTE FUNCTION bump_mcp_registry_version();

-- -----------------------------------------------------------------------------
-- 4. Bump the version once now so any existing Redis cache entry from before
--    this migration is invalidated on the next API request.
-- -----------------------------------------------------------------------------
UPDATE "mcp_registry_version"
   SET "version"   = "version" + 1,
       "updatedAt" = NOW()
 WHERE "id" = 1;
