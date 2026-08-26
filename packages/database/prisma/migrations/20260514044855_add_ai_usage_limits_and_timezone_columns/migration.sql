-- ============================================================================
-- AI Usage Limits + tenant timezone columns + BILLING notification fan-out.
--
-- Schema delta:
--   * 3 new enums:    AiUsageLimitDimension, AiUsageLimitWindow,
--                     AiUsageLimitEnforcement
--   * 1 enum extension: NotificationCategory += BILLING
--   * 1 enum extension: NotificationType  += AI_USAGE_LIMIT_WARNING,
--                                            AI_USAGE_LIMIT_REACHED
--   * 2 new tables:   ai_usage_limit, ai_usage_limit_counter
--                     (ai_usage_limit is created with projectId +
--                     bannerThresholdPercent from the start)
--   * 2 new columns:  user.timezone (TEXT, nullable),
--                     organization.timezone (TEXT, nullable)
--   * 1 IMMUTABLE SQL wrapper for the enum-to-text cast used inside the
--     partial-unique index (Postgres 17 rejects raw CAST in index exprs).
--   * 1 partial-unique index expressed in raw SQL because Prisma's DSL
--     cannot express partial-unique on COALESCE expressions.
--
-- Backward compatibility:
--   * Tenants with no rows in ai_usage_limit see no behaviour change — the
--     chokepoint short-circuits when enumerateApplicableLimits returns [].
--   * timezone columns default to NULL → resolves to "UTC" at read-time via
--     the helpers in packages/payments. No backfill is required.
--   * Both new NotificationType members and the new BILLING category are
--     additive — existing notification consumers ignore unknown enum values.
-- ============================================================================

-- CreateEnum
CREATE TYPE "AiUsageLimitDimension" AS ENUM ('TOKENS', 'SPEND_USD');

-- CreateEnum
CREATE TYPE "AiUsageLimitWindow" AS ENUM ('HOURLY', 'DAILY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "AiUsageLimitEnforcement" AS ENUM ('HARD', 'SOFT');

-- AlterEnum
-- `IF NOT EXISTS` makes the ADD VALUE idempotent. If a previous deploy
-- attempt half-applied this migration (the enum extensions succeeded but a
-- later statement failed) re-running won't double-add and choke.
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'BILLING';

-- AlterEnum
-- ALTER TYPE … ADD VALUE is non-transactional per Postgres docs, so the
-- two ALTER TYPE statements below are executed independently.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'AI_USAGE_LIMIT_WARNING';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'AI_USAGE_LIMIT_REACHED';

-- AlterTable
ALTER TABLE "user" ADD COLUMN "timezone" TEXT;

-- AlterTable
ALTER TABLE "organization" ADD COLUMN "timezone" TEXT;

-- CreateTable
CREATE TABLE "ai_usage_limit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "projectId" TEXT,
    "name" TEXT,
    "providerConfigId" TEXT,
    "modelCanonicalName" TEXT,
    "taskType" "AiTaskType",
    "dimension" "AiUsageLimitDimension" NOT NULL,
    "window" "AiUsageLimitWindow" NOT NULL,
    "maxValue" BIGINT NOT NULL,
    "enforcement" "AiUsageLimitEnforcement" NOT NULL,
    "bannerThresholdPercent" INTEGER NOT NULL DEFAULT 90,
    "createdById" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_usage_limit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_limit_counter" (
    "id" TEXT NOT NULL,
    "limitId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "usedTokens" BIGINT NOT NULL DEFAULT 0,
    "usedMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_usage_limit_counter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_limit_organizationId_archivedAt_idx" ON "ai_usage_limit"("organizationId", "archivedAt");

-- CreateIndex
CREATE INDEX "ai_usage_limit_userId_archivedAt_idx" ON "ai_usage_limit"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "ai_usage_limit_projectId_archivedAt_idx" ON "ai_usage_limit"("projectId", "archivedAt");

-- CreateIndex
CREATE INDEX "ai_usage_limit_providerConfigId_idx" ON "ai_usage_limit"("providerConfigId");

-- CreateIndex
CREATE INDEX "ai_usage_limit_createdById_idx" ON "ai_usage_limit"("createdById");

-- CreateIndex
CREATE INDEX "ai_usage_limit_counter_windowStart_idx" ON "ai_usage_limit_counter"("windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_limit_counter_limitId_windowStart_key" ON "ai_usage_limit_counter"("limitId", "windowStart");

-- AddForeignKey
ALTER TABLE "ai_usage_limit" ADD CONSTRAINT "ai_usage_limit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_limit" ADD CONSTRAINT "ai_usage_limit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_limit" ADD CONSTRAINT "ai_usage_limit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_limit" ADD CONSTRAINT "ai_usage_limit_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_limit_counter" ADD CONSTRAINT "ai_usage_limit_counter_limitId_fkey" FOREIGN KEY ("limitId") REFERENCES "ai_usage_limit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Partial-unique index for tenant-scope deduplication.
--
-- Postgres requires every expression inside a unique index to be IMMUTABLE.
-- `COALESCE(...)` is IMMUTABLE, but `CAST(enum AS TEXT)` is STABLE — Postgres
-- 17 rejects it with `error 42P17 (functions in index expression must be
-- marked IMMUTABLE)`. We wrap the cast in a tiny IMMUTABLE SQL function so
-- the index expression can use it.
--
-- The `WHERE archivedAt IS NULL` clause makes this a partial index —
-- uniqueness only applies to live rows so soft-deleted rows can be preserved
-- alongside a new live row with the same scope.
--
-- The XOR (organizationId XOR userId) is enforced by application code; the
-- COALESCE here just normalises NULL to '' so NULLable columns can
-- participate in the unique key. `projectId` is included so two limits with
-- the same (provider, model, taskType, dimension, window) but different
-- project scopes don't collide.
-- ============================================================================
CREATE OR REPLACE FUNCTION ai_usage_limit_task_type_text(e "AiTaskType")
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
AS $$ SELECT e::text $$;

CREATE UNIQUE INDEX "ai_usage_limit_scope_live_uq"
  ON "ai_usage_limit" (
    COALESCE("organizationId", ''),
    COALESCE("userId", ''),
    COALESCE("projectId", ''),
    COALESCE("providerConfigId", ''),
    COALESCE("modelCanonicalName", ''),
    COALESCE(ai_usage_limit_task_type_text("taskType"), ''),
    "dimension",
    "window"
  )
  WHERE "archivedAt" IS NULL;
