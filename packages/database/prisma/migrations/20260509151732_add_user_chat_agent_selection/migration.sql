-- CreateTable
CREATE TABLE "user_chat_agent_selection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "selectedAgents" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_chat_agent_selection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_chat_agent_selection_userId_idx" ON "user_chat_agent_selection"("userId");

-- CreateIndex
CREATE INDEX "user_chat_agent_selection_organizationId_idx" ON "user_chat_agent_selection"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "user_chat_agent_selection_userId_organizationId_key" ON "user_chat_agent_selection"("userId", "organizationId");

-- AddForeignKey
ALTER TABLE "user_chat_agent_selection" ADD CONSTRAINT "user_chat_agent_selection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
