-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RegisteredAgentSuggestionKind" ADD VALUE 'SKILLS';
ALTER TYPE "RegisteredAgentSuggestionKind" ADD VALUE 'MODEL';
ALTER TYPE "RegisteredAgentSuggestionKind" ADD VALUE 'KNOWLEDGE';
ALTER TYPE "RegisteredAgentSuggestionKind" ADD VALUE 'SUB_AGENT';

-- AlterTable
ALTER TABLE "registered_agent_suggestion" ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "payload" JSONB;

-- CreateIndex
CREATE INDEX "registered_agent_suggestion_conversationId_idx" ON "registered_agent_suggestion"("conversationId");
