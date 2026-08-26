-- AlterEnum
ALTER TYPE "PendingBacklogProposalSource" ADD VALUE 'TEAMS_CHAT';

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "teamsChatMonitorEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "teamsChatMonitorIntervalMin" INTEGER,
ADD COLUMN     "teamsChatMonitorLastRun" TIMESTAMP(3),
ADD COLUMN     "teamsChatMonitorQuietWindowMin" INTEGER DEFAULT 60,
ADD COLUMN     "teamsChatMonitorWorkflowId" TEXT;

-- CreateTable
CREATE TABLE "project_linked_teams_chat" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "chatTopic" TEXT,
    "chatWebUrl" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageCreatedAt" TIMESTAMP(3),
    "lastMessageId" TEXT,
    "scanPageToken" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastErrorMessage" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "project_linked_teams_chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_linked_teams_chat_seen_message" (
    "id" TEXT NOT NULL,
    "linkedChatId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pendingProposalId" TEXT,

    CONSTRAINT "project_linked_teams_chat_seen_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_linked_teams_chat_projectId_idx" ON "project_linked_teams_chat"("projectId");

-- CreateIndex
CREATE INDEX "project_linked_teams_chat_userId_idx" ON "project_linked_teams_chat"("userId");

-- CreateIndex
CREATE INDEX "project_linked_teams_chat_organizationId_idx" ON "project_linked_teams_chat"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "project_linked_teams_chat_projectId_chatId_key" ON "project_linked_teams_chat"("projectId", "chatId");

-- CreateIndex
CREATE INDEX "project_linked_teams_chat_seen_message_linkedChatId_idx" ON "project_linked_teams_chat_seen_message"("linkedChatId");

-- CreateIndex
CREATE UNIQUE INDEX "project_linked_teams_chat_seen_message_linkedChatId_message_key" ON "project_linked_teams_chat_seen_message"("linkedChatId", "messageId");

-- AddForeignKey
ALTER TABLE "project_linked_teams_chat" ADD CONSTRAINT "project_linked_teams_chat_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_linked_teams_chat" ADD CONSTRAINT "project_linked_teams_chat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_linked_teams_chat" ADD CONSTRAINT "project_linked_teams_chat_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_linked_teams_chat_seen_message" ADD CONSTRAINT "project_linked_teams_chat_seen_message_linkedChatId_fkey" FOREIGN KEY ("linkedChatId") REFERENCES "project_linked_teams_chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_linked_teams_chat_seen_message" ADD CONSTRAINT "project_linked_teams_chat_seen_message_pendingProposalId_fkey" FOREIGN KEY ("pendingProposalId") REFERENCES "pending_backlog_proposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
