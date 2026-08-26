-- CreateEnum
CREATE TYPE "PendingBacklogProposalSource" AS ENUM ('TEAMS_CHANNEL');

-- CreateEnum
CREATE TYPE "PendingBacklogProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'APPLIED', 'REJECTED', 'FAILED', 'SUPERSEDED');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "teamsChannelMonitorEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "teamsChannelMonitorIntervalMin" INTEGER,
ADD COLUMN     "teamsChannelMonitorLastRun" TIMESTAMP(3),
ADD COLUMN     "teamsChannelMonitorQuietWindowMin" INTEGER DEFAULT 60,
ADD COLUMN     "teamsChannelMonitorWorkflowId" TEXT;

-- CreateTable
CREATE TABLE "project_linked_teams_channel" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "teamName" TEXT,
    "channelName" TEXT,
    "channelWebUrl" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageCreatedAt" TIMESTAMP(3),
    "lastMessageId" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastErrorMessage" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "project_linked_teams_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_linked_teams_channel_seen_message" (
    "id" TEXT NOT NULL,
    "linkedChannelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pendingProposalId" TEXT,

    CONSTRAINT "project_linked_teams_channel_seen_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_backlog_proposal" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "source" "PendingBacklogProposalSource" NOT NULL,
    "status" "PendingBacklogProposalStatus" NOT NULL DEFAULT 'PENDING',
    "proposal" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "changeCount" INTEGER NOT NULL DEFAULT 0,
    "sourceMetadata" JSONB,
    "applyWorkflowId" TEXT,
    "applyError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "appliedAt" TIMESTAMP(3),
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "pending_backlog_proposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_linked_teams_channel_projectId_idx" ON "project_linked_teams_channel"("projectId");

-- CreateIndex
CREATE INDEX "project_linked_teams_channel_userId_idx" ON "project_linked_teams_channel"("userId");

-- CreateIndex
CREATE INDEX "project_linked_teams_channel_organizationId_idx" ON "project_linked_teams_channel"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "project_linked_teams_channel_projectId_teamId_channelId_key" ON "project_linked_teams_channel"("projectId", "teamId", "channelId");

-- CreateIndex
CREATE INDEX "project_linked_teams_channel_seen_message_linkedChannelId_idx" ON "project_linked_teams_channel_seen_message"("linkedChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "project_linked_teams_channel_seen_message_linkedChannelId_m_key" ON "project_linked_teams_channel_seen_message"("linkedChannelId", "messageId");

-- CreateIndex
CREATE INDEX "pending_backlog_proposal_projectId_status_idx" ON "pending_backlog_proposal"("projectId", "status");

-- CreateIndex
CREATE INDEX "pending_backlog_proposal_userId_idx" ON "pending_backlog_proposal"("userId");

-- CreateIndex
CREATE INDEX "pending_backlog_proposal_organizationId_idx" ON "pending_backlog_proposal"("organizationId");

-- CreateIndex
CREATE INDEX "pending_backlog_proposal_createdAt_idx" ON "pending_backlog_proposal"("createdAt");

-- AddForeignKey
ALTER TABLE "project_linked_teams_channel" ADD CONSTRAINT "project_linked_teams_channel_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_linked_teams_channel" ADD CONSTRAINT "project_linked_teams_channel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_linked_teams_channel" ADD CONSTRAINT "project_linked_teams_channel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_linked_teams_channel_seen_message" ADD CONSTRAINT "project_linked_teams_channel_seen_message_linkedChannelId_fkey" FOREIGN KEY ("linkedChannelId") REFERENCES "project_linked_teams_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_linked_teams_channel_seen_message" ADD CONSTRAINT "project_linked_teams_channel_seen_message_pendingProposalI_fkey" FOREIGN KEY ("pendingProposalId") REFERENCES "pending_backlog_proposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_backlog_proposal" ADD CONSTRAINT "pending_backlog_proposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_backlog_proposal" ADD CONSTRAINT "pending_backlog_proposal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_backlog_proposal" ADD CONSTRAINT "pending_backlog_proposal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_backlog_proposal" ADD CONSTRAINT "pending_backlog_proposal_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
