-- A re-check request, set when a GitHub push or a poll check finds a sync
-- run already open; it holds the last head observed, for diagnostics only.
-- The open run's completion (or, when that run had already finished, the
-- writer's settle) reads it under the row lock and makes the row due now,
-- instead of leaving the push to the 15-minute schedule. Additive:
-- a nullable column with no default, so existing rows read as "nothing
-- pending".
ALTER TABLE "project_instruction_repository_sync" ADD COLUMN "pendingCommitSha" TEXT;
