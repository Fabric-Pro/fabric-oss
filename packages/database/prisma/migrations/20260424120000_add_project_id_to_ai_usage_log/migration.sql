-- AlterTable
ALTER TABLE "ai_usage_log" ADD COLUMN "projectId" TEXT;

-- CreateIndex
CREATE INDEX "ai_usage_log_projectId_createdAt_idx" ON "ai_usage_log"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: attribute historical chat-originated usage rows to their project via conversationId -> ai_chat.projectId
UPDATE "ai_usage_log" AS u
SET "projectId" = c."projectId"
FROM "ai_chat" AS c
WHERE u."conversationId" = c."id"
  AND u."projectId" IS NULL
  AND c."projectId" IS NOT NULL;
