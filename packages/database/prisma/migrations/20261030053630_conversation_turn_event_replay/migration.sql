/*
  Warnings:

  - A unique constraint covering the columns `[id,organizationId,userId]` on the table `conversation_turn` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateTable
CREATE TABLE "conversation_turn_event" (
    "id" BIGSERIAL NOT NULL,
    "turnId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_turn_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_turn_event_turnId_runId_id_idx" ON "conversation_turn_event"("turnId", "runId", "id");

-- CreateIndex
CREATE INDEX "conversation_turn_event_expiresAt_id_idx" ON "conversation_turn_event"("expiresAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_turn_event_turnId_runId_sourceKey_key" ON "conversation_turn_event"("turnId", "runId", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_turn_id_organizationId_userId_key" ON "conversation_turn"("id", "organizationId", "userId");

-- AddForeignKey
ALTER TABLE "conversation_turn_event" ADD CONSTRAINT "conversation_turn_event_turnId_organizationId_userId_fkey" FOREIGN KEY ("turnId", "organizationId", "userId") REFERENCES "conversation_turn"("id", "organizationId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
