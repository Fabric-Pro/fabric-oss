-- Conversation turn token ledger: a durable per-turn token allowance for the
-- Advisor's iterative turn. Every model and embedding request a ledgered turn
-- makes reserves against the turn's allowance before it is sent and settles
-- its reported usage after, so a dead activity attempt, an SDK retry or an
-- attempt with unknown usage stays charged, and a reconnect cannot refill it.
--
-- Schema delta (additive only; nothing existing changes meaning):
--
--   * conversation_turn gains the ledger columns. All are NULLable or carry a
--     constant default, so existing rows read as "no ledger"
--     (budgetContractVersion NULL) and old code that never writes them keeps
--     working. ADD COLUMN with a constant DEFAULT is a catalog-only change on
--     PostgreSQL 11+: no table rewrite, an ACCESS EXCLUSIVE lock held only
--     for the instant of the ALTER.
--   * conversation_turn_attempt is a NEW table: one row per physical request
--     (fresh per SDK step and retry). It cascades with its turn.
--     organizationId and userId are copied from the parent turn on insert
--     (never from the caller), so the table carries the same tenant columns
--     as conversation_turn.
--   * Three NEW enums for the ledger's enforcement, attempt kind and attempt
--     status.
--
-- Tenancy: registered as PER_USER_ORG in src/tenant-db.ts and given the
-- `per_user_within_org` policy in scripts/apply-rls-direct.ts, the same as
-- conversation_turn. The queries use the base client and authorize every
-- reservation and settlement through the parent turn's identity.
--
-- The index and foreign key land on a table this migration CREATEs, so they
-- are built on an empty relation; the foreign key takes a SHARE ROW EXCLUSIVE
-- lock on conversation_turn only for the instant of the ALTER.
--
-- Rollback: forward-only. The old application ignores every new column and
-- the new table, so rolling the code back needs no schema change.
--
-- Generated with `prisma migrate diff` from the previous migrations to this
-- datamodel, so it carries only this change's statements.

-- CreateEnum
CREATE TYPE "ConversationTurnBudgetEnforcement" AS ENUM ('ENFORCED', 'MEASURED_ONLY');

-- CreateEnum
CREATE TYPE "ConversationTurnAttemptKind" AS ENUM ('EXPLORATION', 'FINALIZATION', 'AUXILIARY');

-- CreateEnum
CREATE TYPE "ConversationTurnAttemptStatus" AS ENUM ('RESERVED', 'SETTLED', 'UNKNOWN', 'RELEASED');

-- AlterTable
ALTER TABLE "conversation_turn" ADD COLUMN     "budgetContractVersion" INTEGER,
ADD COLUMN     "budgetEnforcement" "ConversationTurnBudgetEnforcement",
ADD COLUMN     "budgetStop" JSONB,
ADD COLUMN     "finalizationReserveTokens" INTEGER,
ADD COLUMN     "measuredTokens" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "outstandingTokens" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "tokenAllowance" INTEGER;

-- CreateTable
CREATE TABLE "conversation_turn_attempt" (
    "id" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "generation" INTEGER,
    "kind" "ConversationTurnAttemptKind" NOT NULL,
    "enforced" BOOLEAN NOT NULL,
    "reservedTokens" INTEGER NOT NULL,
    "status" "ConversationTurnAttemptStatus" NOT NULL DEFAULT 'RESERVED',
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "workflowId" TEXT,
    "runId" TEXT,
    "activityId" TEXT,
    "activityAttempt" INTEGER,
    "modelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "conversation_turn_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_turn_attempt_turnId_idx" ON "conversation_turn_attempt"("turnId");

-- AddForeignKey
ALTER TABLE "conversation_turn_attempt" ADD CONSTRAINT "conversation_turn_attempt_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "conversation_turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

