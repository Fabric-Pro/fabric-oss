-- CreateTable
CREATE TABLE "project_conversation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "attachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attachedBy" TEXT NOT NULL,

    CONSTRAINT "project_conversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_conversation_projectId_idx" ON "project_conversation"("projectId");

-- CreateIndex
CREATE INDEX "project_conversation_conversationId_idx" ON "project_conversation"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "project_conversation_conversationId_key" ON "project_conversation"("conversationId");

-- AddForeignKey
ALTER TABLE "project_conversation" ADD CONSTRAINT "project_conversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_conversation" ADD CONSTRAINT "project_conversation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_conversation" ADD CONSTRAINT "project_conversation_attachedBy_fkey" FOREIGN KEY ("attachedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
