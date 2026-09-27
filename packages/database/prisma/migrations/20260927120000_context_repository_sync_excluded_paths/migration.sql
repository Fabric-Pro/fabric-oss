-- Living Memory repository sync: what the member left out inside a selected
-- folder (Fizzy #2750 §5.1). Canonical storage keys, sorted, each strictly
-- inside one selected path; a run leaves every entry at or under one out
-- and prunes the managed rows there.
--
-- Additive only. The default is a constant empty array, so the ADD COLUMN is
-- metadata-only on PostgreSQL 11+ (no table rewrite) and every existing row
-- reads as "nothing left out", which is what it meant before. The previous
-- app version neither reads nor writes the column. Nullable, as Prisma
-- writes every scalar list column; the application always writes an array.
-- RLS and the tenant extension already cover the table
-- (`scripts/apply-rls-direct.ts`, `src/tenant-db.ts`); a new column needs no
-- policy change.
--
-- Rollout: exclusions can be written only by the new API, which deploys
-- after the workers that honour them (migrate, then workers, then web), so
-- no old worker ever runs a configuration that carries one.
--
-- lock_timeout FIRST, per the convention in this directory: the timeout has
-- to be in force BEFORE the statement that takes the ACCESS EXCLUSIVE lock,
-- or it guards nothing (see
-- 20260815120300_publishing_cycle_notification_outcome_at). SET LOCAL
-- applies because this file has two statements, and Prisma wraps a
-- multi-statement migration in one transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "project_context_repository_sync" ADD COLUMN     "excludedPaths" TEXT[] DEFAULT ARRAY[]::TEXT[];
