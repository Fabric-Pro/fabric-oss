-- CreateTable
CREATE TABLE "advisor_tool_result" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "advisor_tool_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "advisor_tool_result_conversationId_createdAt_expiresAt_idx" ON "advisor_tool_result"("conversationId", "createdAt" DESC, "expiresAt");

-- CreateIndex
CREATE INDEX "advisor_tool_result_expiresAt_id_idx" ON "advisor_tool_result"("expiresAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "advisor_tool_result_turnId_sourceKey_key" ON "advisor_tool_result"("turnId", "sourceKey");

-- AddForeignKey
ALTER TABLE "advisor_tool_result" ADD CONSTRAINT "advisor_tool_result_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advisor_tool_result" ADD CONSTRAINT "advisor_tool_result_turnId_organizationId_userId_fkey" FOREIGN KEY ("turnId", "organizationId", "userId") REFERENCES "conversation_turn"("id", "organizationId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
