-- Conversation turns: the server-owned record of one Advisor chat turn (one
-- user message's orchestrator run), so Stop can reach a turn before the
-- browser holds its execution id, a conversation runs at most one live turn,
-- and a cancel is recorded durably before Temporal is asked to cancel.
--
-- Schema delta: one NEW table, two NEW enums, their indexes and their foreign
-- keys. Nothing existing is altered.
--
--   * conversation_turn — organizationId is NOT NULL (ADR-018: the
--     organization is the only tenant context) and cascades with the
--     organization; userId cascades with the user. conversationId is SET NULL
--     when the conversation is deleted, and scopeConversationId keeps an
--     immutable copy of it. executionId (the Temporal workflow id) is unique
--     and NULL only on a cancel-before-start tombstone.
--   * (userId, organizationId, clientRequestKey) is unique: the client's
--     per-message idempotency key. (conversationId, generation) is unique:
--     the per-conversation turn number. Both are NULL-tolerant uniques, so a
--     tombstone (NULL generation) and a turn with no conversation never
--     collide.
--   * startToken is a random value written with a START_PENDING turn and
--     returned only to the request that created it. Only its holder may
--     perform the startup-abandonment transitions, so a duplicate request for
--     the same message key cannot end a turn another request is starting.
--
-- Tenancy: registered as PER_USER_ORG in src/tenant-db.ts and given the
-- `per_user_within_org` policy in scripts/apply-rls-direct.ts, the same as
-- agent_conversation.
--
-- Every index and key below lands on a table this migration CREATEs, so each
-- is built on an empty relation. The foreign keys to "user", "organization"
-- and "agent_conversation" take a SHARE ROW EXCLUSIVE lock on those tables
-- only for the instant of the ALTER; no validation scan runs because the new
-- table is empty.
--
-- Generated with `prisma migrate diff` from the previous datamodel to this
-- one, so it carries only this change's statements.

-- CreateEnum
CREATE TYPE "ConversationTurnStatus" AS ENUM ('START_PENDING', 'ACTIVE', 'CANCEL_REQUESTED', 'COMPLETED', 'FAILED', 'LIMITED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ConversationTurnCancelSource" AS ENUM ('USER_STOP', 'CANCELLED_BEFORE_START', 'DISCONNECT_BEFORE_START', 'WORKFLOW_CANCELLED');

-- CreateTable
CREATE TABLE "conversation_turn" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "scopeConversationId" TEXT,
    "clientRequestKey" TEXT NOT NULL,
    "startToken" TEXT,
    "executionId" TEXT,
    "generation" INTEGER,
    "executionMode" TEXT,
    "status" "ConversationTurnStatus" NOT NULL DEFAULT 'START_PENDING',
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelRequestedByUserId" TEXT,
    "cancelSource" "ConversationTurnCancelSource",
    "terminalAt" TIMESTAMP(3),
    "terminalReason" TEXT,
    "responseText" TEXT,
    "limitSignalSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_turn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_turn_executionId_key" ON "conversation_turn"("executionId");

-- CreateIndex
CREATE INDEX "conversation_turn_conversationId_status_idx" ON "conversation_turn"("conversationId", "status");

-- CreateIndex
CREATE INDEX "conversation_turn_organizationId_userId_idx" ON "conversation_turn"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_turn_userId_organizationId_clientRequestKey_key" ON "conversation_turn"("userId", "organizationId", "clientRequestKey");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_turn_conversationId_generation_key" ON "conversation_turn"("conversationId", "generation");

-- AddForeignKey
ALTER TABLE "conversation_turn" ADD CONSTRAINT "conversation_turn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_turn" ADD CONSTRAINT "conversation_turn_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_turn" ADD CONSTRAINT "conversation_turn_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
