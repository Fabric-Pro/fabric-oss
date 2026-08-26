-- AlterTable
ALTER TABLE "ai_chat" ADD COLUMN     "projectId" TEXT;

-- CreateIndex
CREATE INDEX "ai_chat_projectId_idx" ON "ai_chat"("projectId");

-- AddForeignKey
ALTER TABLE "ai_chat" ADD CONSTRAINT "ai_chat_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
