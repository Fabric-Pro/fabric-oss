-- CreateEnum
CREATE TYPE "parlume_action_status" AS ENUM ('PROPOSED', 'AWAITING_CONFIRMATION', 'EXECUTING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'INVALIDATED', 'OUTCOME_UNKNOWN');

-- AlterTable
ALTER TABLE "parlume_meeting_session" ADD COLUMN     "voiceGeneration" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "parlume_meeting_turn" ADD COLUMN     "agentRevision" TEXT,
ADD COLUMN     "firstAudioAt" TIMESTAMP(3),
ADD COLUMN     "firstTextAt" TIMESTAMP(3),
ADD COLUMN     "interruptedAt" TIMESTAMP(3),
ADD COLUMN     "spokenAt" TIMESTAMP(3),
ADD COLUMN     "voiceGeneration" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "parlume_action" (
    "id" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "speakerId" TEXT NOT NULL,
    "speakerName" TEXT,
    "invocationKey" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolFingerprint" TEXT NOT NULL,
    "agentRevision" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "parlume_action_status" NOT NULL DEFAULT 'PROPOSED',
    "presentedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmationTurnId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parlume_action_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "parlume_action_sessionId_speakerId_status_idx" ON "parlume_action"("sessionId", "speakerId", "status");

-- CreateIndex
CREATE INDEX "parlume_action_projectId_createdAt_idx" ON "parlume_action"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "parlume_action_organizationId_createdAt_idx" ON "parlume_action"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "parlume_action_turnId_invocationKey_key" ON "parlume_action"("turnId", "invocationKey");

-- AddForeignKey
ALTER TABLE "parlume_action" ADD CONSTRAINT "parlume_action_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "parlume_meeting_turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
