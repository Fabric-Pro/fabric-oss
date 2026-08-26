-- CreateEnum
CREATE TYPE "AiChatToolSelectionMode" AS ENUM ('DEFAULT', 'ONLY_SELECTED', 'DISABLED');

-- AlterTable
ALTER TABLE "ai_chat"
ADD COLUMN "toolSelectionMode" "AiChatToolSelectionMode" NOT NULL DEFAULT 'DEFAULT';

-- CreateTable
CREATE TABLE "ai_chat_mcp_config" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "mcpConfigId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'conversation',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_chat_mcp_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_chat_mcp_config_chatId_mcpConfigId_key" ON "ai_chat_mcp_config"("chatId", "mcpConfigId");
CREATE INDEX "ai_chat_mcp_config_chatId_idx" ON "ai_chat_mcp_config"("chatId");
CREATE INDEX "ai_chat_mcp_config_mcpConfigId_idx" ON "ai_chat_mcp_config"("mcpConfigId");
CREATE INDEX "ai_chat_mcp_config_userId_idx" ON "ai_chat_mcp_config"("userId");
CREATE INDEX "ai_chat_mcp_config_organizationId_idx" ON "ai_chat_mcp_config"("organizationId");

-- AddForeignKey
ALTER TABLE "ai_chat_mcp_config"
ADD CONSTRAINT "ai_chat_mcp_config_chatId_fkey"
FOREIGN KEY ("chatId") REFERENCES "ai_chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_chat_mcp_config"
ADD CONSTRAINT "ai_chat_mcp_config_mcpConfigId_fkey"
FOREIGN KEY ("mcpConfigId") REFERENCES "mcp_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_chat_mcp_config"
ADD CONSTRAINT "ai_chat_mcp_config_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_chat_mcp_config"
ADD CONSTRAINT "ai_chat_mcp_config_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
