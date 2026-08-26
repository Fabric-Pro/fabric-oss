-- Composite index for the retention purge's keyset walk (#1749).
-- WHERE "deletedAt" < $1 AND "id" > $2 ORDER BY "id" — the existing
-- single-column "deletedAt" index leaves the sort uncovered.
--
-- KEEP THIS MIGRATION TO ONE STATEMENT. Adding a second reintroduces Prisma's
-- transaction wrapper, and CONCURRENTLY cannot run inside one (SQLSTATE 25001).
--
-- Deliberately NO `migration-lint: allow blocking-index` marker here: the
-- CONCURRENTLY keyword already clears that rule, so the marker would suppress
-- nothing today while standing as a FILE-SCOPED exemption that silently excused
-- any non-concurrent index a later edit added to this file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "story_attachment_deletedAt_id_idx"
  ON "story_attachment" ("deletedAt", "id");
