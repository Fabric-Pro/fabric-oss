-- Living Memory repository sync: automatic sync (design 2026-09-23 §11.1,
-- Fizzy #2673). Registers the sync as the second subject of the shared
-- repository-sync poll and GitHub push webhook.
--
-- One enum, two values on an existing enum, and nine columns on
-- "project_context_repository_sync": the scheduling column contract the
-- coding-instructions sync's table already carries, with the same names,
-- types and defaults. No backfill: every existing row takes "automatic" =
-- false and is never claimed until a member turns automatic sync on, which
-- re-configures the row and resets every scheduling column.
--
-- Every ADD COLUMN is nullable or has a non-volatile default, so each is
-- metadata-only in Postgres 11+ (CURRENT_TIMESTAMP is evaluated once, at the
-- ALTER). The previous app version neither reads nor writes these columns.
-- The ("automatic", "nextCheckAt") index the poll's claim reads needs
-- CONCURRENTLY and therefore its own migration (20260924190100).
--
-- Neither new trigger value is used in this migration: a value added by
-- ALTER TYPE cannot be referenced in the transaction that adds it. Enum
-- additions are additive and cannot be safely removed while rows may hold
-- the value; IF NOT EXISTS makes recovery from a partially applied
-- deployment idempotent.
--
-- RLS and the tenant extension already cover both tables
-- (`scripts/apply-rls-direct.ts`, `src/tenant-db.ts`); new columns need no
-- policy change.

-- CreateEnum
CREATE TYPE "ProjectContextSyncPause" AS ENUM ('PERMISSION_REVOKED', 'REF_MISSING');

-- AlterEnum
ALTER TYPE "ProjectContextSyncTrigger" ADD VALUE IF NOT EXISTS 'POLL';

-- AlterEnum
ALTER TYPE "ProjectContextSyncTrigger" ADD VALUE IF NOT EXISTS 'WEBHOOK';

-- AlterTable
ALTER TABLE "project_context_repository_sync" ADD COLUMN     "automatic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "automaticPausedAt" TIMESTAMP(3),
ADD COLUMN     "automaticPausedReason" "ProjectContextSyncPause",
ADD COLUMN     "failureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastEvaluatedCommitSha" TEXT,
ADD COLUMN     "lastEvaluatedGeneration" INTEGER,
ADD COLUMN     "nextCheckAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "suppressedCommitSha" TEXT,
ADD COLUMN     "suppressedGeneration" INTEGER;
