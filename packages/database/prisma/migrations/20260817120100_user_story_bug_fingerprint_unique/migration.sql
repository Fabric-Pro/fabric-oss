-- One NON-TERMINAL bug per (projectId, bugFingerprint). This is the DB-level
-- backstop behind the fingerprint dedup check in the MCP gateway's
-- `fabric_create_bug` handler: the check-then-create window is racy, so two
-- concurrent monitoring-agent calls carrying the same fingerprint would both
-- pass the read. With this index the loser gets a unique violation and the
-- handler re-reads the winner's row and reports it as the existing bug.
--
-- The predicate excludes DECLINED / CLOSED (the TERMINAL_DRAFTING_STAGES set)
-- on purpose, mirroring BacklogDedupGuard: a resolved bug is an immutable
-- record and must not block re-filing when the same error resurfaces after a
-- fix. Postgres maintains a partial index over a mutable predicate correctly —
-- rows enter and leave the index as their stage changes.
--
-- NO `IF NOT EXISTS` — deliberately, and do not add it. A failed concurrent
-- build leaves the index behind with `indisvalid = false`; `IF NOT EXISTS`
-- would then see the name taken on the retry and skip the rebuild, so the
-- migration would be recorded as applied while the uniqueness guarantee this
-- handler depends on silently did not exist. Without the clause the retry
-- fails loudly instead. Recovery per docs/database-promotion.md § "A concurrent
-- build that does fail": find it with
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- then DROP INDEX that name before re-running the migration.
--
-- KEEP THIS MIGRATION TO ONE STATEMENT. A second one reintroduces Prisma's
-- transaction wrapper, and CONCURRENTLY cannot run inside a transaction
-- (SQLSTATE 25001).
CREATE UNIQUE INDEX CONCURRENTLY "user_story_projectId_bugFingerprint_key"
  ON "user_story" ("projectId", "bugFingerprint")
  WHERE "bugFingerprint" IS NOT NULL
    AND "draftingStage" NOT IN ('DECLINED', 'CLOSED');
