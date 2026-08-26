-- AlterEnum
ALTER TYPE "PendingBacklogProposalSource" ADD VALUE 'SLACK_CHANNEL';

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "slackChannelMonitorDebounceMs" INTEGER DEFAULT 30000,
ADD COLUMN     "slackChannelMonitorEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "slackChannelMonitorLastRun" TIMESTAMP(3),
ADD COLUMN     "slackChannelMonitorMaxHoldMs" INTEGER DEFAULT 300000,
ADD COLUMN     "slackChannelMonitorWorkflowId" TEXT;

-- CreateTable
CREATE TABLE "project_linked_slack_channel" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "teamName" TEXT,
    "channelName" TEXT,
    "channelWebUrl" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "monitorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "monitorEnabledAt" TIMESTAMP(3),
    "backfillCompleteAt" TIMESTAMP(3),
    "lastMessageTs" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastErrorMessage" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "project_linked_slack_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_linked_slack_channel_seen_message" (
    "id" TEXT NOT NULL,
    "linkedChannelId" TEXT NOT NULL,
    "messageTs" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pendingProposalId" TEXT,

    CONSTRAINT "project_linked_slack_channel_seen_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_linked_slack_channel_channelId_slackTeamId_idx" ON "project_linked_slack_channel"("channelId", "slackTeamId");

-- CreateIndex
CREATE INDEX "project_linked_slack_channel_projectId_idx" ON "project_linked_slack_channel"("projectId");

-- CreateIndex
CREATE INDEX "project_linked_slack_channel_userId_idx" ON "project_linked_slack_channel"("userId");

-- CreateIndex
CREATE INDEX "project_linked_slack_channel_organizationId_idx" ON "project_linked_slack_channel"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "project_linked_slack_channel_projectId_slackTeamId_channelI_key" ON "project_linked_slack_channel"("projectId", "slackTeamId", "channelId");

-- CreateIndex
CREATE INDEX "project_linked_slack_channel_seen_message_linkedChannelId_idx" ON "project_linked_slack_channel_seen_message"("linkedChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "project_linked_slack_channel_seen_message_linkedChannelId_m_key" ON "project_linked_slack_channel_seen_message"("linkedChannelId", "messageTs");

-- AddForeignKey
ALTER TABLE "project_linked_slack_channel" ADD CONSTRAINT "project_linked_slack_channel_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_linked_slack_channel" ADD CONSTRAINT "project_linked_slack_channel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_linked_slack_channel" ADD CONSTRAINT "project_linked_slack_channel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_linked_slack_channel_seen_message" ADD CONSTRAINT "project_linked_slack_channel_seen_message_linkedChannelId_fkey" FOREIGN KEY ("linkedChannelId") REFERENCES "project_linked_slack_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_linked_slack_channel_seen_message" ADD CONSTRAINT "project_linked_slack_channel_seen_message_pendingProposalI_fkey" FOREIGN KEY ("pendingProposalId") REFERENCES "pending_backlog_proposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
