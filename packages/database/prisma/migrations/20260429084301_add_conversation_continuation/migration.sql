-- AlterTable
ALTER TABLE "agent_conversation" ADD COLUMN     "carriedOverAt" TIMESTAMP(3),
ADD COLUMN     "carriedOverSummary" TEXT,
ADD COLUMN     "parentConversationId" TEXT;

-- CreateIndex
CREATE INDEX "agent_conversation_parentConversationId_idx" ON "agent_conversation"("parentConversationId");

-- AddForeignKey
ALTER TABLE "agent_conversation" ADD CONSTRAINT "agent_conversation_parentConversationId_fkey" FOREIGN KEY ("parentConversationId") REFERENCES "agent_conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
