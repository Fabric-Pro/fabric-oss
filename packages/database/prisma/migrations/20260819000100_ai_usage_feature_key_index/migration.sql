-- Covering index for the per-feature adoption dashboards (Fizzy #2230):
-- per-feature volume and cost over a time range.
--
-- KEEP THIS MIGRATION TO ONE STATEMENT. Adding a second reintroduces Prisma's
-- transaction wrapper, and CONCURRENTLY cannot run inside one (SQLSTATE 25001).
--
-- Deliberately NO `migration-lint: allow blocking-index` marker: the
-- CONCURRENTLY keyword already clears that rule, so the marker would suppress
-- nothing today while standing as a FILE-SCOPED exemption that silently excused
-- any non-concurrent index a later edit added to this file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_usage_log_featureKey_createdAt_idx"
  ON "ai_usage_log" ("featureKey", "createdAt");
