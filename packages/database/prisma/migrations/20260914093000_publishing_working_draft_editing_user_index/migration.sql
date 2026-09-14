-- Supporting index for the advisory editing lock added in
-- 20260914090000_publishing_working_draft_advisory_lock (Fizzy #1851): the
-- sweep that expires stale claims and the "who is in this draft" read both
-- filter on "editingUserId".
--
-- KEEP THIS MIGRATION TO ONE STATEMENT. Adding a second reintroduces Prisma's
-- transaction wrapper, and CONCURRENTLY cannot run inside one (SQLSTATE 25001).
-- That is not hypothetical here: this index and the ALTER TABLE above shipped
-- in ONE file on 2026-09-14, failed with P3018/25001 on the first promotion,
-- left the migration mid-flight and blocked every staging deploy behind it
-- until the ledger was resolved by hand. Splitting them is the fix.
--
-- Deliberately NO `migration-lint: allow blocking-index` marker here: the
-- CONCURRENTLY keyword already clears that rule, so the marker would suppress
-- nothing today while standing as a FILE-SCOPED exemption that silently excused
-- any non-concurrent index a later edit added to this file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "publishing_topic_working_draft_editingUserId_idx"
  ON "publishing_topic_working_draft" ("editingUserId");
