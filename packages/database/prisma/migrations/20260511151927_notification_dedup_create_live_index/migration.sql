-- =============================================================================
-- DEPLOYMENT NOTE — CONCURRENTLY DDL REQUIRES MANUAL APPLICATION
-- =============================================================================
-- This migration uses CREATE INDEX CONCURRENTLY which PostgreSQL forbids
-- inside a transaction block. Prisma's migration engine (`prisma migrate
-- deploy` / `prisma migrate dev`) wraps every migration file in an implicit
-- transaction and has no public SQL directive to disable that wrap as of
-- Prisma 6.18.
--
-- TO APPLY (in any environment that hasn't already): run the SQL below
-- directly via psql, then mark the migration as applied:
--
--   psql "$DATABASE_URL" -f <this-file>
--   npx prisma migrate resolve --applied 20260511151927_notification_dedup_create_live_index
--
-- After both 20260511151927 and 20260511151928 are applied this way, regular
-- `prisma migrate deploy` will see them as already-applied and skip them.
--
-- Follow-up: a wrapper script + CI workflow update to automate this pattern
-- is tracked separately and must land before any environment that hasn't been
-- pre-treated runs `prisma migrate deploy` against these.
-- =============================================================================
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  "notification_userId_dedupeKey_live_uq"
  ON "notification" ("userId", "dedupeKey")
  WHERE "readAt" IS NULL AND "archivedAt" IS NULL AND "dedupeKey" IS NOT NULL;
